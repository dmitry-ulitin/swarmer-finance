import * as accountQueries from '../../db/queries/accounts';
import * as transactionQueries from '../../db/queries/transactions';
import { LEVEL, requireLevel } from '../access';
import { toCents } from '../currency';
import { detectProfile, getProfile, Profile } from './profiles';
import { readStatement } from './rows';
import { computeImportHashes } from './hash';
import { parseCsv } from './csv';

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
}

export interface ParseResult {
  format: string;
  account: { id: number; name: string; currency: string; scale: number };
  rows: ImportRow[];
  summary: { total: number; new: number; duplicate: number; possibleDuplicate: number };
}

// pg returns DATE columns as a Date set to local midnight for that calendar
// day; toISOString() would convert to UTC and can shift the day in either
// direction depending on the local offset. Local getters read back the same
// calendar date node-postgres was given.
function formatDate(date: string | Date): string {
  if (typeof date === 'string') return date.slice(0, 10);
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** The account, once the caller is known to hold WRITE on it. */
async function loadWritableAccount(accountId: number, userId: number) {
  const account = await accountQueries.getAccountById(accountId);
  if (!account || account.deleted) {
    throw { statusCode: 404, message: 'Account not found' };
  }
  await requireLevel(accountId, userId, LEVEL.WRITE);
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

  const text = Buffer.from(contentBase64, 'base64').toString('utf8');
  // Detection needs the grid, and the grid needs a delimiter — every profile
  // today uses ',', so a plain read is enough to find the header.
  const profile = resolveProfile(parseCsv(text), format);

  const { rows, currency } = readStatement(text, profile);

  if (currency !== account.currency) {
    throw {
      statusCode: 400,
      message: `Statement is in ${currency} but the account is in ${account.currency}`,
    };
  }

  const hashes = computeImportHashes(rows, profile);

  // Exact: hashes this account has already seen.
  const existing = new Set(await transactionQueries.findExistingImportHashes(accountId, hashes));

  // Advisory: same date and same amount, catching transactions typed in by
  // hand before importing ever started — those carry no hash at all.
  const dates = [...new Set(rows.map(r => r.date))];
  const sameDay = await transactionQueries.findByDates(accountId, dates);
  const byKey = new Map<string, number>();
  for (const t of sameDay) {
    const d = formatDate(t.date);
    // Income stores the amount in credit, expense in debit; both are equal
    // for single-account rows, so either side keys the match.
    byKey.set(`${d}|${t.credit}`, t.id);
    byKey.set(`${d}|-${t.debit}`, t.id);
  }

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

  const payload = toInsert.map(row => {
    const cents = toCents(Math.abs(row.amount), account.scale);
    const isExpense = row.amount < 0;
    return {
      categoryId:
        row.categoryId ??
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
