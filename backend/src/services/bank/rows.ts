import { EbTransaction } from './client';
import { hashRows } from '../import/hash';
import { isIsoDate } from '../date';
import { ParsedRow, round2 } from '../import/rows';

/** Booked, non-zero transactions in `currency`, as statement-import rows. */
export function toParsedRows(txs: EbTransaction[], currency: string): ParsedRow[] {
  const rows: ParsedRow[] = [];
  for (const tx of txs) {
    if (tx.status !== 'BOOK' || tx.transaction_amount.currency !== currency) continue;
    const date = tx.booking_date || tx.value_date || tx.transaction_date;
    const raw = tx.transaction_amount.amount;
    const abs = typeof raw === 'string' && raw.trim() !== '' ? round2(Number(raw)) : NaN;
    const indicator = tx.credit_debit_indicator;
    if (!date || !isIsoDate(date) || !Number.isFinite(abs) || (indicator !== 'DBIT' && indicator !== 'CRDT')) {
      throw { statusCode: 502, message: 'Bank returned an unreadable transaction' };
    }
    if (abs === 0) continue;
    const debit = indicator === 'DBIT';
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
