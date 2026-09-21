/**
 * `duplicate` is exact — the row's hash is already stored on this account.
 * `possible_duplicate` is advisory: same date and amount as a transaction
 * that carries no hash, i.e. one entered by hand before importing began.
 */
export type ImportRowStatus = 'new' | 'duplicate' | 'possible_duplicate';

export interface ImportRow {
  index: number;
  date: string;
  /** Decimal and signed: positive is income, negative an expense. */
  amount: number;
  description: string;
  payee: string | null;
  hash: string;
  status: ImportRowStatus;
  /** The existing transaction this row matched, for either duplicate kind. */
  duplicateOf: number | null;
}

export interface ImportParseResult {
  format: string;
  account: { id: number; name: string; currency: string; scale: number };
  rows: ImportRow[];
  summary: { total: number; new: number; duplicate: number; possibleDuplicate: number };
}

/** One row as reconcile accepts it; the extra parse-only fields are ignored. */
export interface ImportReconcileRow {
  date: string;
  amount: number;
  description?: string;
  payee?: string | null;
  hash: string;
  categoryId?: number | null;
}

export interface ImportReconcileResult {
  created: number;
  skipped: number;
}

/** Statement formats the backend knows; `null` asks it to detect one. */
export const IMPORT_FORMATS = [
  { id: null, name: 'Detect automatically' },
  { id: 'lhv', name: 'LHV' },
  { id: 'boc', name: 'Bank of Cyprus' },
] as const;

export type ImportFormat = (typeof IMPORT_FORMATS)[number];
