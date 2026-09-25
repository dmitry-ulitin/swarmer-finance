import { createHash } from 'crypto';
import { buildSlots, chainHashes, matchRows } from '../services/chainAdopt';
import type { AccountTxRow } from '../db/queries/transactions';
import type { Plan } from '../services/chainSync';
import { Account } from '../types';

const A = 83;
const TX1 = 'a'.repeat(64);
const TX2 = 'b'.repeat(64);
const none = { in: new Set<string>(), out: new Set<string>() };
/** A statement-import hash: bare sha256 hex, same shape as a txid but never one. */
const csvHash = (input: string) => createHash('sha256').update(input).digest('hex');

const incomeRow = (over: Partial<AccountTxRow>): AccountTxRow => ({
  id: 1, debit_account_id: null, credit_account_id: A, debit: 5000, credit: 5000,
  date: '2026-05-29', description: '', payee: null, import_hash: null, ...over,
});
const expenseRow = (over: Partial<AccountTxRow>): AccountTxRow =>
  incomeRow({ debit_account_id: A, credit_account_id: null, ...over });

const income = (txid: string, amount: number, date = '2026-05-29'): Plan =>
  ({ txid, date, fee: 0, income: { amount, from: 'bc1qx', peer: undefined } });
const payment = (txid: string, amount: number, fee: number, date = '2026-05-29'): Plan =>
  ({ txid, date, fee, expense: { amount, to: 'bc1qshop' } });

describe('chainHashes', () => {
  it('lists every hash the sync can write', () => {
    expect(chainHashes([income(TX1, 1)])).toEqual(new Set([TX1, `${TX1}:out`, `${TX1}:fee`]));
  });
});

describe('buildSlots', () => {
  it('gives income, expense (with the fee-inclusive amount) and fee slots', () => {
    expect(buildSlots([income(TX1, 5000), payment(TX2, 3000, 200)], none)).toEqual([
      { txid: TX1, date: '2026-05-29', hash: TX1, direction: 'in', kind: 'income', amount: 5000, counterparty: 'bc1qx' },
      { txid: TX2, date: '2026-05-29', hash: TX2, direction: 'out', kind: 'expense', amount: 3000, withFee: 3200, counterparty: 'bc1qshop' },
      { txid: TX2, date: '2026-05-29', hash: `${TX2}:fee`, direction: 'out', kind: 'fee', amount: 200, counterparty: null },
    ]);
  });

  it('gives no slot for a receipt from a synced wallet', () => {
    const plan: Plan = { txid: TX1, date: '2026-05-29', fee: 0, income: { amount: 5000, from: 'bc1qb', peer: { id: 9 } as Account } };
    expect(buildSlots([plan], none)).toEqual([]);
  });

  it('gives only the fee slot for a payment to a synced wallet', () => {
    const plan: Plan = {
      txid: TX1, date: '2026-05-29', fee: 100,
      transfer: { amount: 7000, peer: { id: 9 } as Account }, expense: { amount: 1000, to: 'bc1qx' },
    };
    expect(buildSlots([plan], none).map(s => s.kind)).toEqual(['fee']);
  });

  it('skips slots whose hash the account already holds on that side', () => {
    const slots = buildSlots([payment(TX1, 3000, 200)], { in: new Set(), out: new Set([`${TX1}:fee`]) });
    expect(slots.map(s => s.kind)).toEqual(['expense']);
  });
});

describe('matchRows', () => {
  it('matches a txid in the description regardless of amount', () => {
    const slots = buildSlots([income(TX1, 5000)], none);
    const m = matchRows(A, slots, [incomeRow({ credit: 1, debit: 1, description: `tx_hash: ${TX1}` })]);
    expect(m.get(1)?.hash).toBe(TX1);
  });

  it('matches an upper-case txid in the description', () => {
    const slots = buildSlots([income(TX1, 5000)], none);
    const m = matchRows(A, slots, [incomeRow({ description: TX1.toUpperCase() })]);
    expect(m.get(1)?.hash).toBe(TX1);
  });

  it('ignores a CSV import_hash and falls back to the heuristic pass', () => {
    // A statement-imported row's import_hash is a bare sha256 hex — the same
    // shape as a txid, but never one, since reconcile only offers rows whose
    // import_hash is not a fetched plan's hash. Reading it as a txid would
    // manufacture a fake match and hide the row from the heuristic pass.
    const slots = buildSlots([income(TX1, 5000)], none);
    const m = matchRows(A, slots, [incomeRow({ import_hash: csvHash('statement row') })]);
    expect(m.get(1)?.hash).toBe(TX1);
  });

  it('matches by a real txid in the description even when import_hash is a CSV hash', () => {
    const slots = buildSlots([income(TX1, 5000)], none);
    const m = matchRows(A, slots, [
      incomeRow({ import_hash: csvHash('statement row'), description: `tx_hash: ${TX1}`, credit: 1, debit: 1 }),
    ]);
    expect(m.get(1)?.hash).toBe(TX1);
  });

  it('sends an outgoing txid row to the fee slot when it equals the fee, else to the expense', () => {
    const slots = buildSlots([payment(TX1, 3000, 200)], none);
    const m = matchRows(A, slots, [
      expenseRow({ id: 1, debit: 200, credit: 200, description: TX1 }),
      expenseRow({ id: 2, debit: 3100, credit: 3100, description: TX1 }),
    ]);
    expect(m.get(1)?.kind).toBe('fee');
    expect(m.get(2)?.kind).toBe('expense');
  });

  it('adopts only the first of two rows naming the same txid', () => {
    const slots = buildSlots([income(TX1, 5000)], none);
    const m = matchRows(A, slots, [incomeRow({ id: 1, description: TX1 }), incomeRow({ id: 2, description: TX1 })]);
    expect([...m.keys()]).toEqual([1]);
  });

  it('never falls back to the heuristic for a row naming an unknown txid', () => {
    const slots = buildSlots([income(TX1, 5000)], none);
    expect(matchRows(A, slots, [incomeRow({ description: TX2 })]).size).toBe(0);
  });

  it('matches by exact amount within three days', () => {
    const slots = buildSlots([income(TX1, 5000)], none);
    expect(matchRows(A, slots, [incomeRow({ date: '2026-05-26' })]).get(1)?.hash).toBe(TX1);
    expect(matchRows(A, slots, [incomeRow({ date: '2026-05-25' })]).size).toBe(0);
    expect(matchRows(A, slots, [incomeRow({ credit: 5001, debit: 5001 })]).size).toBe(0);
    expect(matchRows(A, slots, [expenseRow({})]).size).toBe(0);
  });

  it('matches an expense entered with its fee', () => {
    const slots = buildSlots([payment(TX1, 3000, 200)], none);
    expect(matchRows(A, slots, [expenseRow({ debit: 3200, credit: 3200 })]).get(1)?.kind).toBe('expense');
  });

  it('refuses ambiguous matches both ways', () => {
    const one = buildSlots([income(TX1, 5000)], none);
    expect(matchRows(A, one, [incomeRow({ id: 1 }), incomeRow({ id: 2 })]).size).toBe(0);
    const two = buildSlots([income(TX1, 5000), income(TX2, 5000)], none);
    expect(matchRows(A, two, [incomeRow({ id: 1 })]).size).toBe(0);
  });

  it('treats a transfer by the side this account is on', () => {
    const slots = buildSlots([income(TX1, 5000)], none);
    const transferIn = incomeRow({ debit_account_id: 77, debit: 120, credit: 5000 });
    expect(matchRows(A, slots, [transferIn]).get(1)?.hash).toBe(TX1);
  });
});
