export type ProfileId = 'lhv' | 'boc';

/**
 * One bank's layout, as data. Everything that differs between statements is
 * a field here, so adding a bank is a data change rather than a code change.
 */
export interface Profile {
  id: ProfileId;
  name: string;
  /** Container format. Only 'csv' is implemented; 'xls' is deferred. */
  reader: 'csv';
  encoding: 'utf8';
  delimiter: string;
  /** Lines of preamble before the header row. */
  skipLines: number;
  /** Columns that together identify this format when none was given. */
  headerSignature: string[];
  dateFormat: 'iso' | 'dd/mm/yyyy';
  /** 'comma' implies '.' groups thousands, as in "39.384,54". */
  decimal: 'dot' | 'comma';
  amount:
    | { kind: 'signed'; column: string; directionColumn?: string; debitFlag?: string }
    | { kind: 'split'; debitColumn: string; creditColumn: string };
  columns: { date: string; description: string; payee?: string };
  currency:
    | { from: 'column'; column: string }
    | { from: 'preamble'; line: number; after: string };
  identity:
    | { kind: 'reference'; columns: string[] }
    | { kind: 'content' };
}

export const PROFILES: Record<ProfileId, Profile> = {
  lhv: {
    id: 'lhv',
    name: 'LHV',
    reader: 'csv',
    encoding: 'utf8',
    delimiter: ',',
    skipLines: 0,
    headerSignature: ['Customer account no', 'Debit/Credit (D/C)', 'Amount'],
    dateFormat: 'iso',
    decimal: 'dot',
    // LHV's Amount is already signed consistently with its D/C column, but
    // the explicit flag is the authority: a bank exporting unsigned amounts
    // with a direction column is common, and trusting the flag fails safe.
    amount: { kind: 'signed', column: 'Amount', directionColumn: 'Debit/Credit (D/C)', debitFlag: 'D' },
    columns: {
      date: 'Date',
      description: 'Description',
      payee: 'Sender/receiver name',
    },
    currency: { from: 'column', column: 'Currency' },
    identity: { kind: 'reference', columns: ['Transaction reference'] },
  },
  boc: {
    id: 'boc',
    name: 'Bank of Cyprus',
    reader: 'csv',
    encoding: 'utf8',
    delimiter: ',',
    skipLines: 5,
    headerSignature: ['Date', 'Description', 'Debit', 'Credit', 'Indicative balance'],
    dateFormat: 'dd/mm/yyyy',
    decimal: 'comma',
    amount: { kind: 'split', debitColumn: 'Debit', creditColumn: 'Credit' },
    // No payee column: the merchant is buried in the description blob, and
    // regex-guessing it is a separate concern.
    columns: { date: 'Date', description: 'Description' },
    currency: { from: 'preamble', line: 4, after: 'Account currency:' },
    identity: { kind: 'reference', columns: ['Bank reference number'] },
  },
};

/** The profile whose header signature appears at its declared offset. */
export function detectProfile(grid: string[][]): Profile | null {
  for (const profile of Object.values(PROFILES)) {
    const header = grid[profile.skipLines];
    if (!header) continue;
    if (profile.headerSignature.every(col => header.includes(col))) return profile;
  }
  return null;
}

export function getProfile(id: string): Profile {
  const profile = PROFILES[id as ProfileId];
  if (!profile) {
    throw {
      statusCode: 400,
      message: `Unknown statement format '${id}'. Supported: ${Object.keys(PROFILES).join(', ')}`,
    };
  }
  return profile;
}
