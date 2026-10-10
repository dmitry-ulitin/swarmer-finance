import * as accountQueries from '../../db/queries/accounts';
import * as transactionQueries from '../../db/queries/transactions';
import { LEVEL, getAccessibleAccountIds, requireLevel } from '../access';
import { convertAmount, getOrRefreshRate, toCents } from '../currency';
import { detectProfile, getProfile, Profile } from './profiles';
import { readStatement } from './rows';
import { computeImportHashes } from './hash';
import { suggestCategories, SuggestionSource } from './categorize';
import { parseCsv } from './csv';
import { isWorkbook, parseWorkbook } from './workbook';
import { getTreeCategoryIds, resolveCategoryForOwner } from '../categories';
import { isTracked } from '../chain';

export type RowStatus = 'new' | 'duplicate' | 'possible_duplicate';

export interface ImportRow {
  index: number;
  date: string;
  amount: number;
  description: string;
  payee: string | null;
  hash: string;
  status: RowStatus;
  duplicateOf: number | null;
  /** Pre-filled category, learned from history; null when nothing is confident. */
  suggestedCategoryId: number | null;
  suggestionSource: SuggestionSource | null;
}

export interface ParseResult {
  format: string;
  account: { id: number; name: string; currency: string; scale: number };
  rows: ImportRow[];
  summary: { total: number; new: number; duplicate: number; possibleDuplicate: number };
}

/** The account, once the caller is known to hold WRITE on it. */
async function loadWritableAccount(accountId: number, userId: number) {
  const account = await accountQueries.getAccountById(accountId);
  // Matches transactions.ts's loadAccount: a missing or deleted account
  // returns 403, not 404, so this endpoint cannot be used to enumerate
  // account ids that exist but belong to someone else.
  if (!account || account.deleted) {
    throw { statusCode: 403, message: 'Cannot use this account' };
  }
  await requireLevel(accountId, userId, LEVEL.WRITE);
  if (isTracked(account)) {
    throw { statusCode: 403, message: 'Transactions of this account are loaded from the blockchain' };
  }
  return account;
}

function resolveProfile(grid: string[][], format?: string): Profile {
  if (format) return getProfile(format);
  const detected = detectProfile(grid);
  if (!detected) {
    throw {
      statusCode: 400,
      message: 'Could not recognise this statement format. Pass "format" explicitly.',
    };
  }
  return detected;
}

export const parseStatement = async (
  userId: number,
  accountId: number,
  contentBase64: string,
  format?: string
): Promise<ParseResult> => {
  const account = await loadWritableAccount(accountId, userId);

  const content = Buffer.from(contentBase64, 'base64');
  // Detection needs the grid, and the grid needs a delimiter — every CSV
  // profile today uses ',', so a plain read is enough to find the header.
  const profile = resolveProfile(
    isWorkbook(content) ? parseWorkbook(content) : parseCsv(content.toString('utf8')),
    format
  );

  const { rows } = readStatement(content, profile, account.currency);

  const hashes = computeImportHashes(rows, profile);

  // Exact: hashes this account has already seen.
  const existing = new Set(await transactionQueries.findExistingImportHashes(accountId, hashes));

  // Advisory: same date and same amount, catching transactions typed in by
  // hand before importing ever started — those carry no hash at all.
  const dates = [...new Set(rows.map(r => r.date))];
  const sameDay = await transactionQueries.findByDates(accountId, dates);
  const byKey = new Map<string, number>();
  for (const t of sameDay) {
    const d = t.date;
    // Only the side that actually belongs to THIS account is keyed — using
    // both sides unconditionally made an expense also register an
    // income-shaped key (and vice versa), matching an imported row of the
    // opposite sign. Transfers count too — one imported from the peer
    // account's statement shows up here again — and each side's amount is in
    // its own account's currency, so this account's side is comparable.
    if (t.debit_account_id === accountId) {
      byKey.set(`${d}|-${t.debit}`, t.id);
    } else if (t.credit_account_id === accountId) {
      byKey.set(`${d}|${t.credit}`, t.id);
    }
  }

  // History from every account the user can see, not just this one: the
  // same merchant is usually paid from several accounts.
  const history = await transactionQueries.findCategorizedHistory(
    await getAccessibleAccountIds(userId)
  );
  // History on a shared account stores the owner's category row. Vote by
  // the row the user's tree shows for that path instead, so co-owners' rows
  // pool their votes and the winner is an id the review screen can display.
  const treeIds = await getTreeCategoryIds(userId);
  const suggestions = suggestCategories(
    rows,
    history.flatMap(h => {
      const categoryId = treeIds.get(h.categoryId);
      return categoryId === undefined ? [] : [{ ...h, categoryId }];
    }),
    profile.categoryKeys
  );

  const out: ImportRow[] = rows.map((row, i) => {
    const hash = hashes[i];
    let status: RowStatus = 'new';
    let duplicateOf: number | null = null;

    if (existing.has(hash)) {
      status = 'duplicate';
    } else {
      const cents = toCents(Math.abs(row.amount), account.scale);
      const key = `${row.date}|${row.amount < 0 ? '-' : ''}${cents}`;
      const match = byKey.get(key);
      if (match !== undefined) {
        status = 'possible_duplicate';
        duplicateOf = match;
      }
    }
    return {
      index: row.index,
      date: row.date,
      amount: row.amount,
      description: row.description,
      payee: row.payee,
      hash,
      status,
      duplicateOf,
      suggestedCategoryId: suggestions[i].categoryId,
      suggestionSource: suggestions[i].source,
    };
  });

  return {
    format: profile.id,
    account: {
      id: account.id,
      name: account.name,
      currency: account.currency,
      scale: account.scale,
    },
    rows: out,
    summary: {
      total: out.length,
      new: out.filter(r => r.status === 'new').length,
      duplicate: out.filter(r => r.status === 'duplicate').length,
      possibleDuplicate: out.filter(r => r.status === 'possible_duplicate').length,
    },
  };
};

const UNCATEGORIZED_INCOME_CATEGORY_ID = 3;
const UNCATEGORIZED_EXPENSE_CATEGORY_ID = 4;

export interface ReconcileRow {
  date: string;
  amount: number;
  description?: string;
  payee?: string | null;
  hash: string;
  categoryId?: number | null;
  /** Makes the row a transfer with this account; its category is then ignored. */
  transferAccountId?: number | null;
}

/**
 * Insert the rows the user chose.
 *
 * The rows come back from the client, so nothing in them is trusted: access
 * is re-checked, amounts are re-converted through the account's own scale,
 * and hashes are re-checked. A client that skips parse entirely and posts
 * straight here gets the same treatment.
 *
 * Only the hash is re-checked. The date-and-amount heuristic is NOT re-run:
 * a row the user reviewed as possible_duplicate and chose to keep must
 * import, and re-applying the advisory match here would silently discard
 * exactly the rows the user made a decision about.
 */
export const reconcile = async (
  userId: number,
  accountId: number,
  rows: ReconcileRow[]
): Promise<{ created: number; skipped: number }> => {
  const account = await loadWritableAccount(accountId, userId);

  if (rows.length === 0) return { created: 0, skipped: 0 };

  for (const row of rows) {
    if (!row.hash) {
      throw { statusCode: 400, message: 'Every row must carry an import hash' };
    }
    if (!Number.isFinite(row.amount) || row.amount === 0) {
      throw { statusCode: 400, message: `Row ${row.date} has no usable amount` };
    }
  }

  const hashes = rows.map(r => r.hash);
  const existing = new Set(
    await transactionQueries.findExistingImportHashes(accountId, hashes)
  );

  // Two rows in one payload can share a hash only if the client duplicated
  // them; keeping the first is consistent with the index rejecting the rest.
  const seen = new Set<string>();
  const toInsert = rows.filter(r => {
    if (existing.has(r.hash) || seen.has(r.hash)) return false;
    seen.add(r.hash);
    return true;
  });

  // Resolve each distinct category id against the account owner (not the
  // caller) before building the payload, exactly like the single-transaction
  // path (transactions.ts). Done once per distinct id, up front, so a 403
  // aborts the whole import rather than inserting some rows first.
  const distinctCategoryIds = [
    ...new Set(toInsert.map(r => r.categoryId).filter((id): id is number => id != null)),
  ];
  const resolvedCategoryIds = new Map<number, number>();
  for (const id of distinctCategoryIds) {
    resolvedCategoryIds.set(id, await resolveCategoryForOwner(id, account.user_id));
  }

  // Transfer peers get the same checks as the imported account, and the
  // rate to each peer's currency is fetched once, up front: the statement
  // carries one amount, so the peer's side is converted at today's rate,
  // for the user to correct by hand if it matters.
  const peers = new Map<number, { scale: number; rate: number }>();
  for (const peerId of new Set(
    toInsert.map(r => r.transferAccountId).filter((id): id is number => id != null)
  )) {
    if (peerId === accountId) {
      throw { statusCode: 400, message: 'A transfer needs two different accounts' };
    }
    const peer = await loadWritableAccount(peerId, userId);
    const rate = await getOrRefreshRate(account.currency, peer.currency);
    if (rate === null) {
      throw {
        statusCode: 400,
        message: `No exchange rate for ${account.currency} to ${peer.currency}`,
      };
    }
    peers.set(peerId, { scale: peer.scale, rate });
  }

  const payload = toInsert.map(row => {
    const cents = toCents(Math.abs(row.amount), account.scale);
    const isExpense = row.amount < 0;
    const peer = row.transferAccountId != null ? peers.get(row.transferAccountId) : undefined;
    if (peer) {
      const peerCents = convertAmount(cents, account.scale, peer.rate, peer.scale)!;
      return {
        categoryId: undefined,
        debitAccountId: isExpense ? accountId : row.transferAccountId!,
        creditAccountId: isExpense ? row.transferAccountId! : accountId,
        debit: isExpense ? cents : peerCents,
        credit: isExpense ? peerCents : cents,
        date: row.date,
        description: row.description ?? '',
        payee: row.payee ?? null,
        importHash: row.hash,
      };
    }
    return {
      categoryId:
        (row.categoryId != null ? resolvedCategoryIds.get(row.categoryId) : undefined) ??
        (isExpense ? UNCATEGORIZED_EXPENSE_CATEGORY_ID : UNCATEGORIZED_INCOME_CATEGORY_ID),
      debitAccountId: isExpense ? accountId : undefined,
      creditAccountId: isExpense ? undefined : accountId,
      debit: cents,
      credit: cents,
      date: row.date,
      description: row.description ?? '',
      payee: row.payee ?? null,
      importHash: row.hash,
    };
  });

  const created = await transactionQueries.createImportedTransactions(userId, payload);
  return { created, skipped: rows.length - created };
};
