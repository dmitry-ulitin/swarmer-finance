# Tracking a Wallet That Has Transactions — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let any crypto account become blockchain-synced; its first sync adopts hand-made rows that match the chain (keeping category, description, transfer peer) and removes the rest.

**Architecture:** `updateAccount` stops refusing untracked → tracked on accounts with transactions; instead it clears the account's `chain_seen_txids` and zeroes `start_balance` in one DB transaction. `syncAccount` detects a first sync (empty seen set) and, inside its DB transaction and before the `apply` loop, runs `reconcile` from a new module `services/chainAdopt.ts`: pure `buildSlots`/`matchRows` decide which rows stand in for which chain rows, then rows are adopted in place (given the chain `import_hash`, date and amount) so `apply`'s `ON CONFLICT DO NOTHING` skips them, and unmatched rows are removed. The frontend confirms the switch in `AccountForm` and `AccountDialogService` syncs right after a save that made the account tracked.

**Tech Stack:** Node + Express + raw SQL (pg), Jest; Angular 22 standalone + Taiga UI v5, Vitest via `ng test`.

**Spec:** `docs/superpowers/specs/2026-09-25-adopt-transactions-on-tracking-design.md`

## Global Constraints

- Response envelope `{ data, error }` unchanged; errors are thrown as `{ statusCode, message }`.
- Amounts are integers at the account's scale; `transactions.debit`/`credit` are `NUMERIC` and come back from pg as strings — wrap in `Number()`.
- Uncategorized income id 3, Uncategorized expense id 4, Network fees id 5.
- Heuristic window: `|row.date − plan.date| ≤ 3 days`; txid pattern: 64 hex digits, case-insensitive, compared lowercase.
- 403 message on missing access: `Cannot reconcile: no write access to account <name>`.
- Confirm dialog: label `Sync from blockchain`, buttons `Enable sync` / `Cancel`, content: `Existing transactions of this account will be reconciled with the blockchain now: matching ones keep their category and description, the rest are removed; transfers to other accounts are left to those accounts. The start balance becomes 0.`
- `describeSync` wording: `N transaction(s) matched`, `N removed`, placed before the existing parts.
- Backend tests: `cd backend && npx jest --testPathPatterns=<name>`. Frontend tests: `cd frontend && npx ng test --watch=false --include=<path>` — never bare `npx vitest`.
- Angular conventions from CLAUDE.md (standalone, OnPush, `inject()`, signals).

## Review Focus

- Two hand rows naming the same txid → the first (lowest id) is adopted, the second removed, no unique-index violation, because the slot is consumed by the first — test in Task 1 (`matchRows`).
- A txid written in upper case in a description (`tx_hash: 9C05…`) → still matched — test in Task 1.
- Re-enabling after a disable, when synced rows with chain hashes are still on the account → their slots count as taken, so no hand row is adopted into an occupied `(account, import_hash)` and the sync does not crash — test in Task 2 (`buildSlots` taken-set) and Task 3 (round trip).
- A candidate transfer whose other account is deleted → still handled (deleted accounts are in both `getAccessMap` and `getAccountsByIds`), left to that account as Uncategorized — covered by the generic detach path; the 403 test in Task 2 pins the permission side.
- An address with no on-chain history yet → the first sync still removes hand-made rows instead of returning early — test in Task 2.

---

## File Structure

- Create `backend/src/services/chainAdopt.ts` — slots, matching (pure) and `reconcile` (DB).
- Modify `backend/src/db/queries/transactions.ts` — row type + five small queries used by reconcile and by enabling tracking.
- Modify `backend/src/services/chainSync.ts` — `SyncResult` fields, first-sync detection, call `reconcile`.
- Modify `backend/src/db/queries/accounts.ts` — `updateAccount` takes an optional `Tx`.
- Modify `backend/src/services/accounts.ts` — new enabling rule.
- Create `backend/src/test/chainAdopt.test.ts`; modify `chainSync.test.ts`, `syncApi.test.ts`, `trackedAccounts.test.ts`.
- Modify `frontend/src/app/models/account.ts`, `features/accounts/account-sync.service.ts`, `account-form/account-form.ts`, `account-dialog.service.ts` and their specs.
- Modify `CLAUDE.md` — one paragraph in the tracked-accounts section.

---

### Task 1: Slots and matching (pure)

**Files:**
- Create: `backend/src/services/chainAdopt.ts`
- Modify: `backend/src/db/queries/transactions.ts` (add `AccountTxRow` type only)
- Test: `backend/src/test/chainAdopt.test.ts`

**Interfaces:**
- Consumes: `Plan` from `backend/src/services/chainSync.ts` (`{ txid, date, fee, income?: { amount, from, peer }, transfer?: { amount, peer }, expense?: { amount, to } }`).
- Produces:
  - `AccountTxRow` (in `db/queries/transactions.ts`): `{ id: number; debit_account_id: number | null; credit_account_id: number | null; debit: number; credit: number; date: string; description: string; payee: string | null; import_hash: string | null; }`
  - `Slot`: `{ txid: string; hash: string; direction: 'in' | 'out'; kind: 'income' | 'expense' | 'fee'; amount: number; withFee?: number; date: string; counterparty: string | null; }`
  - `chainHashes(plans: Plan[]): Set<string>`
  - `buildSlots(plans: Plan[], taken: { in: ReadonlySet<string>; out: ReadonlySet<string> }): Slot[]`
  - `rowDirection(accountId: number, row: AccountTxRow): 'in' | 'out'`
  - `matchRows(accountId: number, slots: Slot[], rows: AccountTxRow[]): Map<number, Slot>` (row id → slot)

- [ ] **Step 1: Add the row type to `db/queries/transactions.ts`**

Append after the `SyncedShape` interface:

```ts
/** A transaction of one account as the first sync's reconciliation reads it; amounts as numbers. */
export interface AccountTxRow {
  id: number;
  debit_account_id: number | null;
  credit_account_id: number | null;
  debit: number;
  credit: number;
  date: string;
  description: string;
  payee: string | null;
  import_hash: string | null;
}
```

- [ ] **Step 2: Write the failing tests**

Create `backend/src/test/chainAdopt.test.ts`:

```ts
import { buildSlots, chainHashes, matchRows } from '../services/chainAdopt';
import type { AccountTxRow } from '../db/queries/transactions';
import type { Plan } from '../services/chainSync';
import { Account } from '../types';

const A = 83;
const TX1 = 'a'.repeat(64);
const TX2 = 'b'.repeat(64);
const none = { in: new Set<string>(), out: new Set<string>() };

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

  it('matches a txid in import_hash and an upper-case one in the description', () => {
    const slots = buildSlots([income(TX1, 5000), income(TX2, 6000)], none);
    const m = matchRows(A, slots, [
      incomeRow({ id: 1, import_hash: `csv:${TX1}` }),
      incomeRow({ id: 2, description: TX2.toUpperCase() }),
    ]);
    expect(m.get(1)?.hash).toBe(TX1);
    expect(m.get(2)?.hash).toBe(TX2);
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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `cd backend && npx jest --testPathPatterns=chainAdopt`
Expected: FAIL — `Cannot find module '../services/chainAdopt'`.

- [ ] **Step 4: Implement `backend/src/services/chainAdopt.ts`**

```ts
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `cd backend && npx jest --testPathPatterns=chainAdopt`
Expected: PASS (all tests).

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/chainAdopt.ts backend/src/db/queries/transactions.ts backend/src/test/chainAdopt.test.ts
git commit -m "feat(sync): match hand-made rows to on-chain transactions"
```

---

### Task 2: Reconcile on the first sync

**Files:**
- Modify: `backend/src/db/queries/transactions.ts` (four queries)
- Modify: `backend/src/services/chainAdopt.ts` (add `reconcile`)
- Modify: `backend/src/services/chainSync.ts` (`SyncResult`, `syncAccount`)
- Test: `backend/src/test/chainSync.test.ts`, `backend/src/test/syncApi.test.ts`

**Interfaces:**
- Consumes: Task 1's `AccountTxRow`, `chainHashes`, `buildSlots`, `rowDirection`, `matchRows`, `Slot`.
- Produces:
  - `findAccountRowsForUpdate(db: Tx, accountId: number): Promise<AccountTxRow[]>`
  - `adoptSyncedRow(db: Tx, id: number, row: { importHash: string; date: string; debit: number; credit: number; payee: string | null }): Promise<void>`
  - `deleteTransactionTx(db: Tx, id: number): Promise<void>`
  - `detachSide(db: Tx, id: number, side: 'debit' | 'credit', categoryId: number): Promise<void>`
  - `reconcile(db: Tx, account: Account, access: Map<number, AccessLevel>, plans: Plan[]): Promise<{ adopted: number; removed: number }>`
  - `SyncResult` becomes `{ added; merged; fees; adopted; removed }` — Task 4's frontend type mirrors it.

- [ ] **Step 1: Update existing result assertions to the new shape**

```bash
cd backend && sed -i -E 's/(fees: [0-9]+) \}/\1, adopted: 0, removed: 0 }/g' src/test/chainSync.test.ts src/test/syncApi.test.ts
git diff --stat
```
Expected: only `toEqual({ added…, fees: N })` lines change (13 in chainSync.test.ts, 2 in syncApi.test.ts). Inspect `git diff` to confirm no other line changed.

- [ ] **Step 2: Write the failing integration tests**

In `backend/src/test/chainSync.test.ts`, inside `describe('syncAccount', …)`, before the closing `});`, add:

```ts
  describe('first sync reconciles rows entered by hand', () => {
    const hex = (n: number) => n.toString(16).padStart(64, '0');
    let salary: number;
    let euro: number;

    beforeAll(async () => {
      salary = (await pool.query(
        'SELECT id FROM categories WHERE user_id = $1 AND parent_id = 1 LIMIT 1', [userId]
      )).rows[0].id;
      euro = (await pool.query(
        `INSERT INTO accounts (user_id, name, currency, scale, start_balance, type, settings)
         VALUES ($1, 'Euro', 'EUR', 2, 0, 'bank', '{}') RETURNING id`, [userId]
      )).rows[0].id;
    });

    const hand = (f: {
      debit?: number | null; credit?: number | null; amountDebit: number; amountCredit?: number;
      category?: number | null; date?: string; description?: string; importHash?: string | null;
    }) => pool.query(
      `INSERT INTO transactions (user_id, category_id, debit_account_id, credit_account_id, debit, credit, date, description, import_hash)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
      [userId, f.category ?? null, f.debit ?? null, f.credit ?? null, f.amountDebit, f.amountCredit ?? f.amountDebit,
       f.date ?? '2026-05-29', f.description ?? '', f.importHash ?? null]
    );
    const seen = async (id: number) =>
      (await pool.query('SELECT COUNT(*)::int AS n FROM chain_seen_txids WHERE account_id = $1', [id])).rows[0].n;

    it('adopts rows that carry their txid, keeping category and description', async () => {
      history.set('bc1qa', [1, 2, 3].map(n => tx(hex(n), 0, [['bc1qx', 1000 * n]])));
      for (const n of [1, 2, 3]) {
        await hand({ credit: walletA, amountDebit: 1000 * n, category: salary, description: `tx_hash: ${hex(n)}`, date: '2026-05-01' });
      }

      await expect(syncAccount(userId, walletA)).resolves.toEqual({ added: 0, merged: 0, fees: 0, adopted: 3, removed: 0 });
      const after = await pool.query(
        `SELECT category_id, description, date, payee, import_hash FROM transactions WHERE credit_account_id = $1 ORDER BY import_hash`, [walletA]
      );
      expect(after.rows).toEqual([1, 2, 3].map(n => ({
        category_id: salary, description: `tx_hash: ${hex(n)}`, date: '2026-05-29', payee: 'bc1qx', import_hash: hex(n),
      })));
    });

    it('turns a hand-kept wallet into the chain, keeping what matched', async () => {
      history.set('bc1qa', [tx('p1', 200, [['bc1qx', -3000]]), tx('r1', 0, [['bc1qy', 5000]])]);
      await hand({ debit: walletA, amountDebit: 3200, category: shop, description: 'Coffee', date: '2026-05-28' });
      await hand({ credit: walletA, amountDebit: 999, category: salary, date: '2026-05-01' });

      await expect(syncAccount(userId, walletA)).resolves.toEqual({ added: 1, merged: 0, fees: 1, adopted: 1, removed: 1 });
      expect(await rows(walletA)).toEqual([
        { debit_account_id: walletA, credit_account_id: null, debit: 3000, credit: 3000, category_id: shop, payee: 'bc1qx', import_hash: 'p1' },
        { debit_account_id: walletA, credit_account_id: null, debit: 200, credit: 200, category_id: 5, payee: null, import_hash: 'p1:fee' },
        { debit_account_id: null, credit_account_id: walletA, debit: 5000, credit: 5000, category_id: 3, payee: 'bc1qy', import_hash: 'r1' },
      ]);
      const desc = await pool.query(`SELECT description FROM transactions WHERE import_hash = 'p1'`);
      expect(desc.rows[0].description).toBe('Coffee');
    });

    it('adopts an imported row whose hash is not a chain hash', async () => {
      history.set('bc1qa', [tx('r2', 0, [['bc1qy', 5000]])]);
      await hand({ credit: walletA, amountDebit: 5000, category: salary, importHash: 'csv-abc' });

      await expect(syncAccount(userId, walletA)).resolves.toMatchObject({ added: 0, adopted: 1 });
      expect((await rows(walletA))[0]).toMatchObject({ import_hash: 'r2', category_id: salary });
    });

    it('keeps a transfer to an untracked account, correcting only what the chain knows', async () => {
      history.set('bc1qa', [tx(hex(4), 0, [['bc1qx', -3000]]), tx(hex(5), 0, [['bc1qx', -4000]])]);
      await hand({ debit: walletA, credit: euro, amountDebit: 2900, amountCredit: 150, description: hex(4) });
      await hand({ debit: walletA, credit: exchange, amountDebit: 3900, description: hex(5) });

      await expect(syncAccount(userId, walletA)).resolves.toMatchObject({ added: 0, adopted: 2, removed: 0 });
      expect(await rows(walletA)).toEqual([
        { debit_account_id: walletA, credit_account_id: euro, debit: 3000, credit: 150, category_id: null, payee: 'bc1qx', import_hash: hex(4) },
        { debit_account_id: walletA, credit_account_id: exchange, debit: 4000, credit: 4000, category_id: null, payee: 'bc1qx', import_hash: hex(5) },
      ]);
    });

    it('leaves an unmatched transfer to its other account, and drops one to a synced wallet', async () => {
      await hand({ debit: exchange, credit: walletA, amountDebit: 700 });
      await hand({ debit: walletA, credit: walletB, amountDebit: 800 });

      await expect(syncAccount(userId, walletA)).resolves.toEqual({ added: 0, merged: 0, fees: 0, adopted: 0, removed: 2 });
      expect(await rows(walletA)).toEqual([]);
      expect(await rows(walletB)).toEqual([]);
      expect(await rows(exchange)).toEqual([
        { debit_account_id: exchange, credit_account_id: null, debit: 700, credit: 700, category_id: 4, payee: null, import_hash: null },
      ]);
    });

    it('removes hand rows of an address with no history yet', async () => {
      await hand({ credit: walletA, amountDebit: 500 });
      await expect(syncAccount(userId, walletA)).resolves.toEqual({ added: 0, merged: 0, fees: 0, adopted: 0, removed: 1 });
      expect(await rows(walletA)).toEqual([]);
    });

    it('refuses without write access to the other account, changing nothing', async () => {
      history.set('bc1qa', [tx('r3', 0, [['bc1qy', 5000]])]);
      await hand({ debit: walletA, credit: exchange, amountDebit: 900 });
      await pool.query('INSERT INTO account_shares (account_id, user_id, level) VALUES ($1, $2, 2)', [walletA, otherUserId]);
      try {
        await expect(syncAccount(otherUserId, walletA)).rejects.toMatchObject({
          statusCode: 403, message: 'Cannot reconcile: no write access to account Exchange',
        });
        expect(await rows(walletA)).toHaveLength(1);
        expect(await seen(walletA)).toBe(0);
      } finally {
        await pool.query('DELETE FROM account_shares WHERE user_id = $1', [otherUserId]);
      }
    });

    it('reconciles only on the first sync', async () => {
      history.set('bc1qa', [tx('r4', 0, [['bc1qy', 5000]])]);
      await syncAccount(userId, walletA);
      await hand({ credit: walletA, amountDebit: 1 });
      await expect(syncAccount(userId, walletA)).resolves.toEqual({ added: 0, merged: 0, fees: 0, adopted: 0, removed: 0 });
      expect(await rows(walletA)).toHaveLength(2);
    });
  });
```

Also, in `afterAll` of the outer describe nothing changes: the Euro account is deleted by `DELETE FROM accounts WHERE user_id = $1`.

- [ ] **Step 3: Run to verify they fail**

Run: `cd backend && npx jest --testPathPatterns=chainSync`
Expected: FAIL — every existing test fails on the missing `adopted`/`removed` keys, and the new ones fail on missing keys or rows.

- [ ] **Step 4: Add the queries to `db/queries/transactions.ts`**

Append after `insertSynced`:

```ts
/** Every transaction of the account, locked for the first sync's reconciliation. */
export const findAccountRowsForUpdate = async (db: Tx, accountId: number): Promise<AccountTxRow[]> => {
  const rows = await db.query<AccountTxRow>(
    `SELECT id, debit_account_id, credit_account_id, debit, credit, date, description, payee, import_hash
     FROM transactions
     WHERE debit_account_id = $1 OR credit_account_id = $1
     ORDER BY id
     FOR UPDATE`,
    [accountId]
  );
  return rows.map(r => ({ ...r, debit: Number(r.debit), credit: Number(r.credit) }));
};

/** Turns a hand-made row into the synced row it stands in for; accounts and category stay. */
export const adoptSyncedRow = async (
  db: Tx,
  id: number,
  row: { importHash: string; date: string; debit: number; credit: number; payee: string | null }
): Promise<void> => {
  await db.query(
    `UPDATE transactions SET import_hash = $1, date = $2, debit = $3, credit = $4, payee = $5 WHERE id = $6`,
    [row.importHash, row.date, row.debit, row.credit, row.payee, id]
  );
};

export const deleteTransactionTx = async (db: Tx, id: number): Promise<void> => {
  await db.query('DELETE FROM transactions WHERE id = $1', [id]);
};

/**
 * Drops one side of a transfer, leaving the other account an uncategorized
 * income or expense of its own amount — as purgeAccountTransactions does.
 */
export const detachSide = async (db: Tx, id: number, side: 'debit' | 'credit', categoryId: number): Promise<void> => {
  await db.query(
    side === 'debit'
      ? 'UPDATE transactions SET debit_account_id = NULL, debit = credit, category_id = $2 WHERE id = $1'
      : 'UPDATE transactions SET credit_account_id = NULL, credit = debit, category_id = $2 WHERE id = $1',
    [id, categoryId]
  );
};
```

- [ ] **Step 5: Add `reconcile` to `services/chainAdopt.ts`**

Replace the import block at the top with:

```ts
import { Tx } from '../db';
import * as accountQueries from '../db/queries/accounts';
import * as transactionQueries from '../db/queries/transactions';
import type { AccountTxRow } from '../db/queries/transactions';
import { Account } from '../types';
import { AccessLevel, LEVEL } from './access';
import { isTracked } from './chain';
import type { Plan } from './chainSync';

const UNCATEGORIZED_INCOME_CATEGORY_ID = 3;
const UNCATEGORIZED_EXPENSE_CATEGORY_ID = 4;
```

Append at the end of the file:

```ts
/**
 * The first sync after an account became tracked: rows the sync did not
 * write (by hand, from a statement, from before tracking was switched off)
 * are adopted when they match an on-chain transaction, or removed. Runs
 * before apply, which then finds adopted rows by their import_hash and
 * inserts nothing for them.
 */
export async function reconcile(
  db: Tx,
  account: Account,
  access: Map<number, AccessLevel>,
  plans: Plan[]
): Promise<{ adopted: number; removed: number }> {
  const rows = await transactionQueries.findAccountRowsForUpdate(db, account.id);
  const hashes = chainHashes(plans);
  const isChainRow = (r: AccountTxRow) => r.import_hash !== null && hashes.has(r.import_hash);
  const candidates = rows.filter(r => !isChainRow(r));
  if (candidates.length === 0) return { adopted: 0, removed: 0 };

  const otherOf = (r: AccountTxRow) => (r.debit_account_id === account.id ? r.credit_account_id : r.debit_account_id);
  const otherIds = [...new Set(candidates.map(otherOf))].filter((id): id is number => id !== null && id !== account.id);
  const others = new Map((await accountQueries.getAccountsByIds(otherIds)).map(a => [a.id, a]));
  for (const other of others.values()) {
    if ((access.get(other.id) ?? 0) < LEVEL.WRITE) {
      throw { statusCode: 403, message: `Cannot reconcile: no write access to account ${other.name}` };
    }
  }

  const taken = { in: new Set<string>(), out: new Set<string>() };
  for (const r of rows.filter(isChainRow)) taken[rowDirection(account.id, r)].add(r.import_hash!);
  // The other wallet's sync owns a transfer with a tracked account.
  const adoptable = candidates.filter(r => {
    const other = otherOf(r);
    return other === null || (other !== account.id && !isTracked(others.get(other)!));
  });
  const matched = matchRows(account.id, buildSlots(plans, taken), adoptable);

  for (const row of candidates) {
    const other = otherOf(row);
    const otherAccount = other === null || other === account.id ? undefined : others.get(other);
    const inbound = rowDirection(account.id, row) === 'in';
    const slot = matched.get(row.id);
    if (slot) {
      const theirs = otherAccount && otherAccount.currency !== account.currency
        ? (inbound ? row.debit : row.credit)
        : slot.amount;
      await transactionQueries.adoptSyncedRow(db, row.id, {
        importHash: slot.hash,
        date: slot.date,
        debit: inbound ? theirs : slot.amount,
        credit: inbound ? slot.amount : theirs,
        payee: row.payee ?? slot.counterparty,
      });
    } else if (!otherAccount || (isTracked(otherAccount) && row.import_hash === null)) {
      await transactionQueries.deleteTransactionTx(db, row.id);
    } else {
      await transactionQueries.detachSide(
        db, row.id, inbound ? 'credit' : 'debit',
        inbound ? UNCATEGORIZED_EXPENSE_CATEGORY_ID : UNCATEGORIZED_INCOME_CATEGORY_ID
      );
    }
  }
  return { adopted: matched.size, removed: candidates.length - matched.size };
}
```

- [ ] **Step 6: Wire it into `services/chainSync.ts`**

Add the import: `import { reconcile } from './chainAdopt';`

Extend `SyncResult`:

```ts
export interface SyncResult {
  /** New income / expense / transfer rows. */
  added: number;
  /** Rows of another synced wallet turned into a transfer with this one. */
  merged: number;
  /** New Network fees rows. */
  fees: number;
  /** Rows already on the account adopted as synced rows on its first sync. */
  adopted: number;
  /** Rows already on the account that matched nothing on the chain. */
  removed: number;
}
```

In `syncAccount`, replace from `const known = …` to the end of the function with:

```ts
  // Everything from the network first: a failure part-way through paging
  // must leave the database untouched.
  const known = new Set(await transactionQueries.findSeenTxids(accountId));
  const txs = await provider.fetchNewTxs(account.settings.address as string, known);
  // An empty seen set means tracking was just switched on (or the address has
  // no history yet): rows already on the account are reconciled, even when
  // the chain has nothing for them to match.
  const firstSync = known.size === 0;
  if (txs.length === 0 && !firstSync) return { added: 0, merged: 0, fees: 0, adopted: 0, removed: 0 };

  const peers = await loadPeers(access, account);
  const peerIds = new Set([...peers.values()].map(a => a.id));
  const plans = txs.map(tx => planTx(tx, peers));
  const categories = await suggest(userId, account, access, plans);

  return withTransaction(async db => {
    const result: SyncResult = { added: 0, merged: 0, fees: 0, adopted: 0, removed: 0 };
    if (firstSync) {
      Object.assign(result, await reconcile(db, account, access, plans));
    }
    for (const plan of plans) {
      await apply(db, userId, account, plan, peerIds, categories, result);
    }
    await transactionQueries.markTxidsSeen(db, accountId, plans.map(p => p.txid));
    return result;
  });
};
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `cd backend && npx jest --testPathPatterns='chainSync|syncApi|chainAdopt|syncedTransactions'`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add backend/src
git commit -m "feat(sync): reconcile existing rows on a wallet's first sync"
```

---

### Task 3: Allow switching tracking on for an account with transactions

**Files:**
- Modify: `backend/src/db/queries/transactions.ts` (add `clearSeenTxids`)
- Modify: `backend/src/db/queries/accounts.ts:46-88` (`updateAccount` takes a `Tx`)
- Modify: `backend/src/services/accounts.ts:128-152`
- Test: `backend/src/test/trackedAccounts.test.ts`

**Interfaces:**
- Consumes: Task 2's reconciliation on first sync (for the round-trip test).
- Produces: `clearSeenTxids(db: Tx, accountId: number): Promise<void>`; `accountQueries.updateAccount(id, data, db?: Pick<Tx, 'query'>)`.

- [ ] **Step 1: Write the failing tests**

In `backend/src/test/trackedAccounts.test.ts`, add imports at the top:

```ts
import { bitcoinProvider } from '../services/chain/bitcoin';
```

Replace the tests `refuses to track an account that has transactions` and `refuses to track an account with a start balance` with:

```ts
    const seenCount = async (id: number) =>
      (await pool.query('SELECT COUNT(*)::int AS n FROM chain_seen_txids WHERE account_id = $1', [id])).rows[0].n;

    it('tracks an account that has transactions, clearing its seen set', async () => {
      const plain = await create({ name: 'Used', currency: 'BTC', startBalance: 0, type: 'crypto', settings: {} });
      const id = plain.body.data.id;
      await addTransaction(id);
      await pool.query(`INSERT INTO chain_seen_txids (account_id, txid) VALUES ($1, 'stale')`, [id]);

      const res = await update(id, { name: 'Used', currency: 'BTC', startBalance: 0, ...WALLET });
      expect(res.status).toBe(200);
      expect(res.body.data.tracked).toBe(true);
      expect(await seenCount(id)).toBe(0);
    });

    it('zeroes the start balance when tracking is switched on', async () => {
      const plain = await create({ name: 'Funded', currency: 'BTC', startBalance: 1, type: 'crypto', settings: {} });
      const res = await update(plain.body.data.id, { name: 'Funded', currency: 'BTC', startBalance: 0, ...WALLET });
      expect(res.status).toBe(200);
      expect(Number(res.body.data.start_balance)).toBe(0);
    });

    it('keeps the seen set when a tracked account is saved again', async () => {
      const w = await create({ name: 'Kept', currency: 'BTC', startBalance: 0, ...WALLET });
      const id = w.body.data.id;
      await pool.query(`INSERT INTO chain_seen_txids (account_id, txid) VALUES ($1, 'known')`, [id]);
      await update(id, { name: 'Kept 2', currency: 'BTC', startBalance: 0, ...WALLET });
      expect(await seenCount(id)).toBe(1);
    });

    it('restores a deleted synced row when tracking is switched off and on again', async () => {
      const spy = jest.spyOn(bitcoinProvider, 'fetchNewTxs').mockImplementation(async (_a, known) =>
        [
          { txid: 'rt1', date: '2026-05-29', fee: 0, transfers: [{ counterparty: 'bc1qx', amount: 5000 }] },
          { txid: 'rt2', date: '2026-05-29', fee: 0, transfers: [{ counterparty: 'bc1qy', amount: 6000 }] },
        ].filter(t => !known.has(t.txid))
      );
      try {
        const w = await create({ name: 'Round', currency: 'BTC', startBalance: 0, type: 'crypto',
          settings: { address: 'bc1qround', blockchain: 'bitcoin' } });
        const id = w.body.data.id;
        const sync = () => request(app).post(`/api/accounts/${id}/sync`).set(auth());
        expect((await sync()).body.data).toMatchObject({ added: 2 });
        await pool.query(`UPDATE transactions SET description = 'kept' WHERE import_hash = 'rt1'`);

        await update(id, { name: 'Round', currency: 'BTC', startBalance: 0, type: 'crypto', settings: { blockchain: 'bitcoin' } });
        await pool.query(`DELETE FROM transactions WHERE import_hash = 'rt2'`);
        await update(id, { name: 'Round', currency: 'BTC', startBalance: 0, type: 'crypto',
          settings: { address: 'bc1qround', blockchain: 'bitcoin' } });

        expect((await sync()).body.data).toEqual({ added: 1, merged: 0, fees: 0, adopted: 0, removed: 0 });
        const after = await pool.query(
          'SELECT import_hash, description FROM transactions WHERE credit_account_id = $1 ORDER BY import_hash', [id]
        );
        expect(after.rows).toEqual([{ import_hash: 'rt1', description: 'kept' }, { import_hash: 'rt2', description: '' }]);
      } finally {
        spy.mockRestore();
      }
    });
```

No cleanup change is needed: `chain_seen_txids` rows go with their account (`ON DELETE CASCADE`, migration 013).

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && npx jest --testPathPatterns=trackedAccounts`
Expected: FAIL — the two enabling tests get 400 `create a new account`; seen-set test fails on count.

- [ ] **Step 3: Add `clearSeenTxids` to `db/queries/transactions.ts`**

After `markTxidsSeen`:

```ts
/** Forgets what the account's sync processed, so the next sync reads the whole history. */
export const clearSeenTxids = async (db: Tx, accountId: number): Promise<void> => {
  await db.query('DELETE FROM chain_seen_txids WHERE account_id = $1', [accountId]);
};
```

- [ ] **Step 4: Let `accountQueries.updateAccount` run in a transaction**

In `backend/src/db/queries/accounts.ts`, change the signature and the call:

```ts
export const updateAccount = async (
  id: number,
  data: {
    name?: string;
    currency?: string;
    startBalance?: number;
    scale?: number;
    type: AccountType;
    settings: Record<string, unknown>;
  },
  db: Pick<Tx, 'query'> = { query }
): Promise<Account | null> => {
```

and replace `const result = await query<Account>(` with `const result = await db.query<Account>(`.

- [ ] **Step 5: Change the rule in `services/accounts.ts`**

Add `clearSeenTxids` to the existing import from `'../db/queries/transactions'`. Replace the block from `const provider = isTracked(data) ? …` through `const account = await accountQueries.updateAccount(id, { ...data, scale, startBalance });` with:

```ts
  const provider = isTracked(data) ? getProvider(data.settings.blockchain) : null;
  const wasTracked = isTracked(existing);
  if (provider) {
    assertTrackedShape(provider, currency, data.startBalance);
    // Rows already on a tracked account came from its wallet; pointing it at
    // another wallet would mix two histories. An untracked account's rows are
    // reconciled by its first sync instead (services/chainAdopt.ts).
    const sameWallet = wasTracked
      && existing.settings.address === data.settings.address
      && existing.settings.blockchain === data.settings.blockchain;
    if (wasTracked && !sameWallet && (Number(existing.start_balance) !== 0 || await accountQueries.hasTransactions(id))) {
      throw { statusCode: 400, message: 'Cannot change the wallet of an account that already has transactions' };
    }
  }
  // Switching tracking on: the balance comes from the chain from now on, and
  // an empty seen set makes the next sync read the whole history and
  // reconcile the rows already here.
  const enablesTracking = provider !== null && !wasTracked;

  const startBalance = enablesTracking
    ? 0
    : data.startBalance != null ? toCents(data.startBalance, scale) : undefined;
  const account = await withTransaction(async tx => {
    if (enablesTracking) await clearSeenTxids(tx, id);
    return accountQueries.updateAccount(id, { ...data, scale, startBalance }, tx);
  });
```

(`withTransaction` is already imported in this file.)

- [ ] **Step 6: Run the tests to verify they pass**

Run: `cd backend && npx jest --testPathPatterns='trackedAccounts|accounts|accountScale|chainSync'`
Expected: PASS.

- [ ] **Step 7: Run the whole backend suite and the build**

Run: `cd backend && npm test && npm run build`
Expected: all suites PASS, `tsc` exits 0.

- [ ] **Step 8: Commit**

```bash
git add backend/src
git commit -m "feat(accounts): allow tracking a wallet that already has transactions"
```

---

### Task 4: Report matched and removed rows

**Files:**
- Modify: `frontend/src/app/models/account.ts:48-52`
- Modify: `frontend/src/app/features/accounts/account-sync.service.ts:11-17`
- Test: `frontend/src/app/features/accounts/account-sync.service.spec.ts`

**Interfaces:**
- Consumes: backend `SyncResult` from Task 2.
- Produces: `AccountSyncResult { added; merged; fees; adopted; removed }`.

- [ ] **Step 1: Write the failing test**

In `account-sync.service.spec.ts`, replace the `describe('describeSync', …)` block with:

```ts
describe('describeSync', () => {
  const none = { added: 0, merged: 0, fees: 0, adopted: 0, removed: 0 };

  it('says so when nothing changed', () => {
    expect(describeSync(none)).toBe('Already up to date');
  });

  it('lists only non-zero counts', () => {
    expect(describeSync({ ...none, added: 12, fees: 3 })).toBe('12 transactions added, 3 fees');
    expect(describeSync({ ...none, added: 1, merged: 1, fees: 1 })).toBe('1 transaction added, 1 merged into a transfer, 1 fee');
  });

  it('reports rows matched and removed on the first sync first', () => {
    expect(describeSync({ ...none, adopted: 130, removed: 6, added: 3, fees: 2 }))
      .toBe('130 transactions matched, 6 removed, 3 transactions added, 2 fees');
    expect(describeSync({ ...none, adopted: 1 })).toBe('1 transaction matched');
  });
});
```

Also update any other `{ added: …, merged: …, fees: … }` literal in this spec (the service test's mocked API response) to include `adopted: 0, removed: 0`.

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx ng test --watch=false --include=src/app/features/accounts/account-sync.service.spec.ts`
Expected: FAIL — type error on `adopted` or the new expectation.

- [ ] **Step 3: Implement**

`models/account.ts`:

```ts
export interface AccountSyncResult {
  added: number;
  merged: number;
  fees: number;
  /** Rows already on the account kept as synced rows (first sync only). */
  adopted: number;
  /** Rows already on the account that matched nothing on the chain. */
  removed: number;
}
```

`account-sync.service.ts`, `describeSync`:

```ts
export function describeSync(r: AccountSyncResult): string {
  const parts: string[] = [];
  if (r.adopted) parts.push(`${plural(r.adopted, 'transaction', 'transactions')} matched`);
  if (r.removed) parts.push(`${r.removed} removed`);
  if (r.added) parts.push(`${plural(r.added, 'transaction', 'transactions')} added`);
  if (r.merged) parts.push(`${r.merged} merged into ${r.merged === 1 ? 'a transfer' : 'transfers'}`);
  if (r.fees) parts.push(plural(r.fees, 'fee', 'fees'));
  return parts.length > 0 ? parts.join(', ') : 'Already up to date';
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && npx ng test --watch=false --include=src/app/features/accounts/account-sync.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/app/models/account.ts frontend/src/app/features/accounts/account-sync.service.ts frontend/src/app/features/accounts/account-sync.service.spec.ts
git commit -m "feat(frontend): report matched and removed rows after a sync"
```

---

### Task 5: Confirm switching tracking on

**Files:**
- Modify: `frontend/src/app/features/accounts/account-form/account-form.ts`
- Test: `frontend/src/app/features/accounts/account-form/account-form.spec.ts`

**Interfaces:**
- Consumes: `Account.tracked` (already in the model), `AccountsState.update`.
- Produces: nothing used by other tasks.

- [ ] **Step 1: Write the failing tests**

In `account-form.spec.ts`, add imports:

```ts
import { vi } from 'vitest';
import { of } from 'rxjs';
import { TuiDialogService } from '@taiga-ui/core';
import { AccountsState } from '../../../core/accounts.state';
```

Change `createForm` to accept a dialog mock:

```ts
function createForm(data: Partial<Account> | null, dialogOpen = vi.fn(() => of(true))) {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: POLYMORPHEUS_CONTEXT, useValue: { data, completeWith: () => {} } },
      { provide: TuiDialogService, useValue: { open: dialogOpen } },
    ],
  });
  return TestBed.createComponent(AccountForm).componentInstance;
}
```

Append:

```ts
describe('AccountForm switching sync on', () => {
  beforeEach(() => TestBed.resetTestingModule());

  const plainWallet = {
    id: 7, name: 'Cold', currency: 'BTC', start_balance: 0, type: 'crypto', settings: {}, tracked: false,
  } as Partial<Account>;
  const spyUpdate = () => vi.spyOn(TestBed.inject(AccountsState), 'update')
    .mockReturnValue(of({ data: { ...plainWallet, tracked: true } as Account, error: null }));
  const track = (form: AccountForm) => form.form.patchValue({ name: 'Cold', address: 'bc1qcold', blockchain: 'bitcoin' });

  it('asks before switching sync on for an existing account, and saves on yes', async () => {
    const dialogOpen = vi.fn(() => of(true));
    const form = createForm(plainWallet, dialogOpen);
    const update = spyUpdate();
    track(form);
    await form.onSubmit();
    expect(dialogOpen).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalled();
  });

  it('sends nothing when the confirmation is cancelled', async () => {
    const form = createForm(plainWallet, vi.fn(() => of(false)));
    const update = spyUpdate();
    track(form);
    await form.onSubmit();
    expect(update).not.toHaveBeenCalled();
  });

  it('does not ask when a tracked account is saved again', async () => {
    const dialogOpen = vi.fn(() => of(true));
    const form = createForm({ ...plainWallet, tracked: true, settings: { address: 'bc1qcold', blockchain: 'bitcoin' } }, dialogOpen);
    spyUpdate();
    await form.onSubmit();
    expect(dialogOpen).not.toHaveBeenCalled();
  });

  it('does not ask when creating a tracked account', async () => {
    const dialogOpen = vi.fn(() => of(true));
    const form = createForm({ currency: 'BTC' }, dialogOpen);
    vi.spyOn(TestBed.inject(AccountsState), 'create').mockReturnValue(of({ data: plainWallet as Account, error: null }));
    form.form.patchValue({ type: 'crypto' });
    track(form);
    await form.onSubmit();
    expect(dialogOpen).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd frontend && npx ng test --watch=false --include=src/app/features/accounts/account-form/account-form.spec.ts`
Expected: FAIL — the first test sees `dialogOpen` never called; the cancel test sees `update` called.

- [ ] **Step 3: Implement in `account-form.ts`**

Imports: add `TuiDialogService` to the `@taiga-ui/core` import, and `import { TUI_CONFIRM, type TuiConfirmData } from '@taiga-ui/kit';` (merge with the existing `@taiga-ui/kit` import line).

Field, next to `notifications`:

```ts
  private readonly dialogs = inject(TuiDialogService);
```

In `onSubmit`, right after `if (this.form.invalid) return;`:

```ts
    if (this.switchesSyncOn() && !await this.confirmSync()) return;
```

New private methods after `cancel()`:

```ts
  /** An existing account starts syncing: its rows get reconciled with the chain. */
  private switchesSyncOn(): boolean {
    const data = this.context.data;
    return data?.id != null && !data.tracked && this.tracked();
  }

  private confirmSync(): Promise<boolean> {
    const data: TuiConfirmData = {
      content: 'Existing transactions of this account will be reconciled with the blockchain now: '
        + 'matching ones keep their category and description, the rest are removed; '
        + 'transfers to other accounts are left to those accounts. The start balance becomes 0.',
      yes: 'Enable sync',
      no: 'Cancel',
    };
    return firstValueFrom(
      this.dialogs.open<boolean>(TUI_CONFIRM, { label: 'Sync from blockchain', size: 's', data }),
      { defaultValue: false }
    );
  }
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd frontend && npx ng test --watch=false --include=src/app/features/accounts/account-form/account-form.spec.ts`
Expected: PASS (old and new tests).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/app/features/accounts/account-form
git commit -m "feat(frontend): confirm before an account starts syncing"
```

---

### Task 6: Sync right after an account becomes tracked

**Files:**
- Modify: `frontend/src/app/features/accounts/account-dialog.service.ts`
- Test: `frontend/src/app/features/accounts/account-dialog.service.spec.ts`

**Interfaces:**
- Consumes: `AccountSyncService.sync(account: Account): Promise<void>` (existing; reports its own errors).
- Produces: nothing used by other tasks.

- [ ] **Step 1: Write the failing tests**

In `account-dialog.service.spec.ts`, add `import { AccountSyncService } from './account-sync.service';`. In **both** existing `configureTestingModule` provider lists add `{ provide: AccountSyncService, useValue: { sync: vi.fn() } },` (the real service needs `HttpClient`).

Append:

```ts
describe('AccountDialogService syncs a newly tracked account', () => {
  let service: AccountDialogService;
  let dialogOpen: ReturnType<typeof vi.fn>;
  let sync: ReturnType<typeof vi.fn>;
  const wallet: Account = { ...account, type: 'crypto', currency: 'BTC', scale: 8, tracked: false,
    settings: {} };
  const tracked: Account = { ...wallet, tracked: true, settings: { address: 'bc1qcold', blockchain: 'bitcoin' } };

  beforeEach(() => {
    dialogOpen = vi.fn();
    sync = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        { provide: TuiDialogService, useValue: { open: dialogOpen } },
        { provide: AccountsState, useValue: {} },
        { provide: AuthService, useValue: { user: () => null } },
        { provide: TransactionsState, useValue: { reload: vi.fn() } },
        { provide: NotificationService, useValue: { showError: vi.fn() } },
        { provide: AccountSyncService, useValue: { sync } },
      ],
    });
    service = TestBed.inject(AccountDialogService);
  });

  it('syncs after switching tracking on', async () => {
    dialogOpen.mockReturnValue(of(tracked));
    await service.openEdit(wallet);
    expect(sync).toHaveBeenCalledWith(tracked);
  });

  it('syncs after creating a tracked account', async () => {
    dialogOpen.mockReturnValue(of(tracked));
    await service.openCreate();
    expect(sync).toHaveBeenCalledWith(tracked);
  });

  it('does not sync a re-saved tracked account, an untracked one, or a cancelled form', async () => {
    dialogOpen.mockReturnValue(of(tracked));
    await service.openEdit(tracked);
    dialogOpen.mockReturnValue(of(wallet));
    await service.openCreate();
    dialogOpen.mockReturnValue(of(null));
    await service.openEdit(wallet);
    expect(sync).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd frontend && npx ng test --watch=false --include=src/app/features/accounts/account-dialog.service.spec.ts`
Expected: FAIL — `sync` never called in the first two tests.

- [ ] **Step 3: Implement in `account-dialog.service.ts`**

Import: `import { AccountSyncService } from './account-sync.service';`. Field:

```ts
  private readonly sync = inject(AccountSyncService);
```

`openCreate` — replace the `return await firstValueFrom(…)` with:

```ts
      const saved = await firstValueFrom(
        this.dialogs.open<Account | null>(
          new PolymorpheusComponent(AccountForm, this.injector),
          { data: { currency: this.auth.user()?.currency || 'EUR' }, label: 'Add Account', size: 's' }
        ),
        { defaultValue: null }
      );
      this.syncIfNewlyTracked(null, saved);
      return saved;
```

`openEdit` — replace the `await firstValueFrom(…)` with:

```ts
      const saved = await firstValueFrom(
        this.dialogs.open<Account | null>(
          new PolymorpheusComponent(AccountForm, this.injector),
          { data: account, label: 'Edit Account', size: 's' }
        ),
        { defaultValue: null }
      );
      this.syncIfNewlyTracked(account, saved);
```

Private method at the end of the class, before `confirm`:

```ts
  /**
   * A wallet that just became tracked has a zero start balance and rows not
   * yet reconciled with the chain; syncing at once keeps its balance right.
   * The sync service reports its own success or failure.
   */
  private syncIfNewlyTracked(before: Account | null, saved: Account | null): void {
    if (saved?.tracked && !before?.tracked) void this.sync.sync(saved);
  }
```

- [ ] **Step 4: Run to verify they pass**

Run: `cd frontend && npx ng test --watch=false --include=src/app/features/accounts/account-dialog.service.spec.ts`
Expected: PASS.

- [ ] **Step 5: Run the whole frontend suite and the build**

Run: `cd frontend && npm test -- --watch=false && npm run build`
Expected: all specs PASS; build succeeds.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/app/features/accounts/account-dialog.service.ts frontend/src/app/features/accounts/account-dialog.service.spec.ts
git commit -m "feat(frontend): sync an account as soon as it becomes tracked"
```

---

### Task 7: Document and check against real data

**Files:**
- Modify: `CLAUDE.md` (section "Blockchain-synced (tracked) accounts")

- [ ] **Step 1: Update CLAUDE.md**

After the sentence ending `…merged whichever side syncs first.`, add:

```markdown
An account that already has transactions can be made tracked: switching
tracking on clears its `chain_seen_txids` and zeroes `start_balance`, and
the first sync (`services/chainAdopt.ts`) adopts rows that match an
on-chain transaction — by a txid in `import_hash`/`description`, else by
exact amount and date ±3 days — keeping their category and description,
and removes the rest (transfers are left to the other account).
```

- [ ] **Step 2: Check account #83 on a copy of the dev database**

The user's backend on :3000 is connected to `finance_db_nu`, so copy by dump rather than `CREATE DATABASE … TEMPLATE`:

```bash
docker exec swarmer-finance-postgres-1 sh -c 'createdb -U finance_user finance_db_nu_check && pg_dump -U finance_user finance_db_nu | psql -q -U finance_user finance_db_nu_check'
cd backend && DATABASE_URL=postgresql://finance_user:123456@localhost:5432/finance_db_nu_check npx tsx -e "
import { updateAccount } from './src/services/accounts';
import { syncAccount } from './src/services/chainSync';
(async () => {
  const a = await updateAccount(83, 2, { name: 'GoMining', currency: 'BTC', startBalance: 0, type: 'crypto',
    settings: { address: 'bc1q3yxr3gkes4nmjvtmn5h5qasyh7jzusxzezys75', blockchain: 'bitcoin' } });
  console.log('tracked', a.tracked, 'balance', a.balance);
  console.log(await syncAccount(2, 83));
  process.exit(0);
})();"
docker exec swarmer-finance-postgres-1 psql -U finance_user -d finance_db_nu_check -c "select count(*) filter (where category_id = 6003) interest, count(import_hash) hashed, sum(credit) from transactions where credit_account_id = 83"
```

Expected: `tracked true`; sync result `{ added: 0, merged: 0, fees: 0, adopted: 136, removed: 0 }`; `interest = 136, hashed = 136, sum = 8220906`.

- [ ] **Step 3: Drop the copy**

```bash
docker exec swarmer-finance-postgres-1 dropdb -U finance_user finance_db_nu_check
```

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: tracking a wallet that already has transactions"
```
