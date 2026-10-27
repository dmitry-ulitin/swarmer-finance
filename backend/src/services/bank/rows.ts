import { EbTransaction } from './client';
import { hashRows } from '../import/hash';
import { ParsedRow, round2 } from '../import/rows';

/** Booked, non-zero transactions in `currency`, as statement-import rows. */
export function toParsedRows(txs: EbTransaction[], currency: string): ParsedRow[] {
  const rows: ParsedRow[] = [];
  for (const tx of txs) {
    if (tx.status !== 'BOOK' || tx.transaction_amount.currency !== currency) continue;
    const date = tx.booking_date || tx.value_date || tx.transaction_date;
    if (!date) continue;
    const abs = round2(Number(tx.transaction_amount.amount));
    if (!Number.isFinite(abs) || abs === 0) continue;
    const debit = tx.credit_debit_indicator === 'DBIT';
    rows.push({
      index: rows.length,
      date,
      amount: debit ? -abs : abs,
      description: (tx.remittance_information ?? []).join(' '),
      payee: (debit ? tx.creditor?.name : tx.debtor?.name) || null,
      reference: tx.entry_reference || tx.transaction_id || null,
    });
  }
  return rows;
}

export function computeBankHashes(
  rows: ParsedRow[],
  aspsp: { name: string; country: string }
): string[] {
  return hashRows(rows, `eb|${aspsp.country}|${aspsp.name}`, true);
}
