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
