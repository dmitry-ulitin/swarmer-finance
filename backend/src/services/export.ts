import { TransactionFilters } from '../db/queries/transactions';
import { TransactionAccount, TransactionDTO } from '../types';
import { findVisible } from './transactions';

/** The statement's columns; `services/import/profiles.ts` `swarmer` reads them back. */
export const EXPORT_COLUMNS = [
  'Date', 'Account', 'Type', 'Category', 'Amount', 'Currency',
  'Counter account', 'Counter amount', 'Counter currency',
  'Payee', 'Description', 'Id',
] as const;

export interface ExportPreview {
  rows: number;
  accounts: number;
  from: string | null;
  to: string | null;
}

/** An integer at `scale` as a plain decimal, without float rounding: -12345 at 2 is "-123.45". */
export function formatAmount(amount: number, scale: number): string {
  const sign = amount < 0 ? '-' : '';
  const digits = String(Math.abs(amount)).padStart(scale + 1, '0');
  if (scale === 0) return sign + digits;
  return `${sign}${digits.slice(0, -scale)}.${digits.slice(-scale)}`;
}

function csvField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

const typeOf = (t: TransactionDTO): string =>
  t.debit_account && t.credit_account ? 'transfer' : t.debit_account ? 'expense' : 'income';

interface ExportRow {
  accountId: number;
  cells: string[];
}

/**
 * One row per side of a transaction on an exported account: a transfer
 * between two exported accounts is two rows, as it is in two bank
 * statements. Money leaving the account is negative.
 */
function toRows(transactions: TransactionDTO[], exported: Set<number>): ExportRow[] {
  const rows: ExportRow[] = [];
  const side = (t: TransactionDTO, account: TransactionAccount, amount: number,
    counter: TransactionAccount | null, counterAmount: number) => {
    rows.push({ accountId: account.id, cells: [
      t.date,
      account.name,
      typeOf(t),
      t.category?.fullName ?? '',
      formatAmount(amount, account.scale),
      account.currency,
      counter?.name ?? '',
      counter ? formatAmount(counterAmount, counter.scale) : '',
      counter?.currency ?? '',
      t.payee ?? '',
      t.description ?? '',
      String(t.id),
    ] });
  };
  for (const t of transactions) {
    if (t.debit_account && exported.has(t.debit_account.id)) {
      side(t, t.debit_account, -t.debit, t.credit_account, t.credit);
    }
    if (t.credit_account && exported.has(t.credit_account.id)) {
      side(t, t.credit_account, t.credit, t.debit_account, -t.debit);
    }
  }
  return rows;
}

async function exportRows(userId: number, filters: TransactionFilters): Promise<ExportRow[]> {
  const { transactions, accountIds } = await findVisible(userId, {
    ...filters, offset: undefined, limit: null, ascending: true,
  });
  return toRows(transactions, new Set(accountIds));
}

/** The transactions list's current filter as a CSV statement, UTF-8 with a BOM for Excel. */
export async function exportCsv(userId: number, filters: TransactionFilters): Promise<string> {
  const rows = await exportRows(userId, filters);
  const lines = [[...EXPORT_COLUMNS], ...rows.map(r => r.cells)].map(r => r.map(csvField).join(','));
  return '\uFEFF' + lines.map(l => l + '\r\n').join('');
}

/** What `exportCsv` would write, counted, so the user sees the scale before downloading. */
export async function previewExport(userId: number, filters: TransactionFilters): Promise<ExportPreview> {
  const rows = await exportRows(userId, filters);
  return {
    rows: rows.length,
    accounts: new Set(rows.map(r => r.accountId)).size,
    from: rows[0]?.cells[0] ?? null,
    to: rows[rows.length - 1]?.cells[0] ?? null,
  };
}
