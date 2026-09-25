import type { AccountTxRow } from '../db/queries/transactions';
import type { Plan } from './chainSync';

/**
 * A row the sync would insert for one on-chain transaction — one that a row
 * entered by hand (or imported from a statement) can stand in for.
 */
export interface Slot {
  txid: string;
  hash: string;
  direction: 'in' | 'out';
  kind: 'income' | 'expense' | 'fee';
  amount: number;
  /** An expense entered by hand often includes the fee. */
  withFee?: number;
  date: string;
  counterparty: string | null;
}

const TXID = /\b[0-9a-f]{64}\b/i;
const WINDOW_MS = 3 * 86_400_000;

/** Every import_hash the sync can write for these plans. */
export function chainHashes(plans: Plan[]): Set<string> {
  return new Set(plans.flatMap(p => [p.txid, `${p.txid}:out`, `${p.txid}:fee`]));
}

/**
 * Slots only where apply inserts a row rather than merging one: a receipt
 * from a synced wallet or a payment to one is the merge logic's business.
 * A slot whose hash the account already holds on that side is filled.
 */
export function buildSlots(plans: Plan[], taken: { in: ReadonlySet<string>; out: ReadonlySet<string> }): Slot[] {
  const slots: Slot[] = [];
  for (const p of plans) {
    const base = { txid: p.txid, date: p.date };
    if (p.income && !p.income.peer) {
      slots.push({ ...base, hash: p.txid, direction: 'in', kind: 'income', amount: p.income.amount, counterparty: p.income.from });
    }
    if (p.expense && !p.transfer) {
      slots.push({
        ...base, hash: p.txid, direction: 'out', kind: 'expense', amount: p.expense.amount,
        ...(p.fee > 0 ? { withFee: p.expense.amount + p.fee } : {}),
        counterparty: p.expense.to,
      });
    }
    if (p.fee > 0) {
      slots.push({ ...base, hash: `${p.txid}:fee`, direction: 'out', kind: 'fee', amount: p.fee, counterparty: null });
    }
  }
  return slots.filter(s => !taken[s.direction].has(s.hash));
}

export const rowDirection = (accountId: number, row: AccountTxRow): 'in' | 'out' =>
  row.credit_account_id === accountId ? 'in' : 'out';

const rowAmount = (accountId: number, row: AccountTxRow): number =>
  rowDirection(accountId, row) === 'in' ? row.credit : row.debit;

const txidOf = (row: AccountTxRow): string | undefined =>
  (row.import_hash?.match(TXID) ?? row.description.match(TXID))?.[0].toLowerCase();

/**
 * Which row stands in for which slot. A txid written on the row decides
 * alone; otherwise direction, exact amount and a date within three days
 * must single out one slot, and that slot must be singled out by no other
 * row.
 */
export function matchRows(accountId: number, slots: Slot[], rows: AccountTxRow[]): Map<number, Slot> {
  const matched = new Map<number, Slot>();
  const used = new Set<Slot>();

  for (const row of rows) {
    const txid = txidOf(row);
    if (txid === undefined) continue;
    const dir = rowDirection(accountId, row);
    const own = slots.filter(s => s.txid === txid && s.direction === dir && !used.has(s));
    const slot = dir === 'in'
      ? own[0]
      : own.find(s => s.kind === 'fee' && s.amount === rowAmount(accountId, row)) ?? own.find(s => s.kind === 'expense');
    if (slot) {
      matched.set(row.id, slot);
      used.add(slot);
    }
  }

  const rest = rows.filter(r => txidOf(r) === undefined);
  const free = slots.filter(s => !used.has(s));
  const fits = (row: AccountTxRow, slot: Slot): boolean => {
    const amount = rowAmount(accountId, row);
    return slot.direction === rowDirection(accountId, row)
      && (slot.amount === amount || slot.withFee === amount)
      && Math.abs(Date.parse(row.date) - Date.parse(slot.date)) <= WINDOW_MS;
  };
  const fitting = new Map(rest.map(r => [r, free.filter(s => fits(r, s))]));
  for (const [row, options] of fitting) {
    if (options.length !== 1) continue;
    const rivals = rest.filter(r => fitting.get(r)!.includes(options[0]));
    if (rivals.length === 1) matched.set(row.id, options[0]);
  }
  return matched;
}
