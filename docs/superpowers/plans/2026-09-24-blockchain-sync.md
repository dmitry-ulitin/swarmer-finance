# Blockchain Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Crypto accounts that name a Bitcoin address load their transactions from the blockchain on a button press, and the app stops users from hand-editing what the chain states.

**Architecture:** A chain-agnostic provider interface (`services/chain/`) with a Bitcoin/Esplora implementation turns on-chain history into normalised `ChainTx` records; `services/chainSync.ts` maps them onto the existing single `transactions` table (identity in `import_hash`), merging transfers between two tracked wallets. Rules live in the service layer (`accounts.ts`, `transactions.ts`, `import/index.ts`); the frontend mirrors them for UX only.

**Tech Stack:** Node/Express/pg/zod/Jest (backend, raw SQL), Angular 22 + Taiga UI v5 + Vitest (frontend). Native `fetch` for HTTP — no new dependencies.

**Spec:** `docs/superpowers/specs/2026-09-24-blockchain-sync-design.md`

## Global Constraints

- Tracked account = `type = 'crypto'` AND non-empty `settings.address` AND `settings.blockchain` has a provider (today only `bitcoin`).
- Esplora base URL: env `BITCOIN_ESPLORA_URL`, default `https://mempool.space/api`; request timeout 10 s.
- Error mapping: network error / timeout / 5xx / 429 → 502 `Blockchain API unavailable`; Esplora 400 → 400 `Invalid address`.
- Bitcoin: currency `BTC`, scale `8` (amounts stored as satoshis in the existing NUMERIC "cents" columns).
- System category `Network fees` = id `5`, parent `2`; Uncategorized income/expense = `3`/`4`.
- Hashes: main row `txid`; expense beside a transfer `txid:out`; fee `txid:fee`.
- API envelope `{ data, error }` everywhere; errors thrown as `{ statusCode, message }`.
- Angular: standalone, `OnPush`, `input()/output()`, `computed()`, `@if/@for`, no `ngClass/ngStyle`.
- Backend tests: `cd backend && npx jest --testPathPatterns=<name>`; frontend tests: `cd frontend && npx ng test --watch=false --include=<path>` (never bare vitest).
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Sync of an account whose history has no new txs** — must return `{added:0, merged:0, fees:0}` without opening a DB transaction or touching rows (Task 5 test "re-sync is a no-op").
2. **Frontend sends every field on edit, unchanged** — the edit form always submits date/payee/amounts; the backend must accept identical values on a synced row and only reject real changes (Task 4 test "accepts an unchanged full payload").
3. **A shared tracked account synced by a non-owner with WRITE** — category suggestions must be resolved against the account owner, like import (Task 5 test "files rows with categories resolved for the owner").
4. **Tracked account soft-deleted** — sync must refuse (403) rather than write into it (Task 5 test).
5. **Existing ordinary transactions moved onto a tracked account via edit** — must be refused (Task 4 test "refuses moving an ordinary transaction onto a synced account").

---

## File Structure

Backend:
- Create `backend/src/db/migrations/012_add_network_fees_category.sql` — system category 5.
- Create `backend/src/services/chain/types.ts` — `ChainTx`, `ChainTransfer`, `ChainProvider`.
- Create `backend/src/services/chain/bitcoin.ts` — Esplora client and UTXO → `ChainTx`.
- Create `backend/src/services/chain/index.ts` — provider registry, `getProvider`, `isTracked`.
- Create `backend/src/services/chainSync.ts` — `planTx` (pure) and `syncAccount`.
- Modify `backend/src/services/categories.ts` — protect id 5.
- Modify `backend/src/services/accounts.ts` — tracked-account rules, `tracked` in DTO.
- Modify `backend/src/types/index.ts` — `Account.tracked?`.
- Modify `backend/src/services/transactions.ts` — create/delete/update rules.
- Modify `backend/src/services/import/index.ts` — refuse import into tracked account.
- Modify `backend/src/db/queries/transactions.ts` — sync queries.
- Modify `backend/src/routes/accounts.ts` — `POST /:id/sync`.
- Tests: `backend/src/test/bitcoinProvider.test.ts`, `trackedAccounts.test.ts`, `syncedTransactions.test.ts`, `chainSync.test.ts`, `syncApi.test.ts`, fixture `backend/src/test/fixtures/chain/tx-95333b08.json`; extend `categories.test.ts`.

Frontend:
- Modify `frontend/src/app/models/account.ts` — `tracked?`, `AccountSyncResult`, `SYNCED_CHAINS`.
- Modify `frontend/src/app/core/api.service.ts` — `syncAccount`.
- Modify `frontend/src/app/core/accounts.state.ts` — `trackedIds`.
- Create `frontend/src/app/features/accounts/account-sync.service.ts` (+ spec).
- Modify `account-tree-node.{ts,html}` — Sync button.
- Modify `account-form.{ts,html,spec.ts}` — chain select, locks.
- Create `frontend/src/app/features/transactions/synced-lock.ts` (+ spec).
- Modify `transaction-form.{ts,html,spec.ts}`, `transaction-dialog.service.ts`, `header.{ts,html}`.

Docs: `CLAUDE.md`, `.env.example`.

---

### Task 1: Network fees system category

**Files:**
- Create: `backend/src/db/migrations/012_add_network_fees_category.sql`
- Modify: `backend/src/services/categories.ts` (the two `id === 1 || … || id === 4` guards in `updateCategory` / `deleteCategory`)
- Test: `backend/src/test/categories.test.ts`

**Interfaces:**
- Produces: category id `5` (`Network fees`, parent 2, `user_id NULL`), protected like 1–4.

- [ ] **Step 1: Write the failing tests**

In `backend/src/test/categories.test.ts`, inside `describe('GET /api/categories')` after the "should nest Uncategorized…" test, add:

```ts
    it('seeds Network fees under Expenses', async () => {
      const res = await request(app)
        .get('/api/categories')
        .set({ Authorization: `Bearer ${token}` });

      const expenses = res.body.data.find((c: any) => c.id === 2);
      expect(expenses.children.some((c: any) => c.id === 5 && c.name === 'Network fees')).toBe(true);
    });
```

After the "should not allow editing the Uncategorized category" test, add:

```ts
    it('should not allow editing the Network fees category', async () => {
      const res = await request(app)
        .put('/api/categories/5')
        .set({ Authorization: `Bearer ${token}` })
        .send({ name: 'Hacked' });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('Cannot edit system categories');
    });
```

After the "should not allow deleting the Uncategorized category" test, add:

```ts
    it('should not allow deleting the Network fees category', async () => {
      const res = await request(app)
        .delete('/api/categories/5')
        .set({ Authorization: `Bearer ${token}` });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('Cannot delete system categories');
    });
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && npx jest --testPathPatterns=categories.test`
Expected: the three new tests FAIL (no id 5; edit/delete return 404, not 403).

- [ ] **Step 3: Write the migration**

`backend/src/db/migrations/012_add_network_fees_category.sql`:

```sql
-- 012_add_network_fees_category.sql
-- System category for blockchain network fees, filed by services/chainSync.ts.
--
-- No ON CONFLICT: migration 002 moved categories_id_seq to MAX(id) + 10, so
-- id 5 was never handed out. If it somehow is taken, the migration must fail
-- loudly rather than silently leave sync pointing at someone's category.
INSERT INTO categories (id, user_id, name, color, icon, parent_id)
VALUES (5, NULL, 'Network fees', '#888888', 'bitcoin', 2);
```

- [ ] **Step 4: Protect id 5**

In `backend/src/services/categories.ts`, change both guards:

```ts
  if (id === 1 || id === 2 || id === 3 || id === 4 || id === 5) {
```

(one in `updateCategory`, one in `deleteCategory`; messages unchanged).

- [ ] **Step 5: Apply the migration to the dev and test databases**

Run:
```bash
cd backend && npm run migrate
DATABASE_URL="$(grep '^TEST_DATABASE_URL=' .env | cut -d= -f2-)" npm run migrate
```
Expected: both print `Running migration: 012_add_network_fees_category.sql` then `All migrations completed successfully`. (`dotenv` does not override an already-set `DATABASE_URL`.)

- [ ] **Step 6: Run the tests**

Run: `cd backend && npx jest --testPathPatterns=categories`
Expected: PASS (all categories and sharedCategories tests).

- [ ] **Step 7: Commit**

```bash
git add backend/src/db/migrations/012_add_network_fees_category.sql backend/src/services/categories.ts backend/src/test/categories.test.ts
git commit -m "feat(categories): add Network fees system category

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Bitcoin provider

**Files:**
- Create: `backend/src/services/chain/types.ts`
- Create: `backend/src/services/chain/bitcoin.ts`
- Create: `backend/src/test/fixtures/chain/tx-95333b08.json`
- Test: `backend/src/test/bitcoinProvider.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // services/chain/types.ts
  export interface ChainTransfer { counterparty: string; amount: number }
  export interface ChainTx { txid: string; date: string; fee: number; transfers: ChainTransfer[] }
  export interface ChainProvider {
    currency: string;
    scale: number;
    fetchNewTxs(address: string, known: ReadonlySet<string>): Promise<ChainTx[]>;
  }
  // services/chain/bitcoin.ts
  export interface EsploraTx { … }
  export function toChainTx(tx: EsploraTx, address: string): ChainTx;
  export const bitcoinProvider: ChainProvider; // currency 'BTC', scale 8
  ```
  `fetchNewTxs` returns only txids not in `known`, **oldest first**. Received txs have exactly one positive transfer; paid txs have only negative transfers (change excluded) and `fee = tx.fee`.

- [ ] **Step 1: Add the fixture**

A real transaction (block 951534, 2026-05-29) from `bc1qda5r…k56` paying 283 outputs, one of them 146435 sats to the test address `bc1q3yxr…ys75`. Trimmed to three outputs; the last one carries the sum of the 281 dropped outputs, so every total is preserved. `backend/src/test/fixtures/chain/tx-95333b08.json`:

```json
{
  "_note": "Real tx 95333b08…, trimmed: 281 outputs merged into the last one; input, fee and totals unchanged.",
  "txid": "95333b087645e5fa1c2b64ea5e62f41ac3929a673aa7186697cf3a73916cd51d",
  "fee": 9214,
  "status": { "confirmed": true, "block_height": 951534, "block_time": 1780040936 },
  "vin": [
    { "prevout": { "scriptpubkey_address": "bc1qda5r9p5l9l74r2gzuz992nvda8d2lezr2wzk56", "value": 238639861 } }
  ],
  "vout": [
    { "scriptpubkey_address": "bc1qy0rlysheyqwrjhs6e8ya82urst9d479wa24mrn", "value": 10000 },
    { "scriptpubkey_address": "bc1q3yxr3gkes4nmjvtmn5h5qasyh7jzusxzezys75", "value": 146435 },
    { "scriptpubkey_address": "bc1q9rxk6kyv3lky39mtysl0hjjwvuauzfrt0m2mk7", "value": 238474212 }
  ]
}
```

- [ ] **Step 2: Write the failing tests**

`backend/src/test/bitcoinProvider.test.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';
import { bitcoinProvider, toChainTx, EsploraTx } from '../services/chain/bitcoin';

const SENDER = 'bc1qda5r9p5l9l74r2gzuz992nvda8d2lezr2wzk56';
const RECEIVER = 'bc1q3yxr3gkes4nmjvtmn5h5qasyh7jzusxzezys75';
const real: EsploraTx = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'chain', 'tx-95333b08.json'), 'utf8')
);

const S = 'bc1qself';
function tx(txid: string, vin: [string, number][], vout: [string, number][], fee = 0): EsploraTx {
  return {
    txid,
    fee,
    status: { confirmed: true, block_time: 1780040936 },
    vin: vin.map(([a, v]) => ({ prevout: { scriptpubkey_address: a, value: v } })),
    vout: vout.map(([a, v]) => ({ scriptpubkey_address: a, value: v })),
  };
}

describe('toChainTx', () => {
  it('reads a real payment from the sender side', () => {
    expect(toChainTx(real, SENDER)).toEqual({
      txid: real.txid,
      date: '2026-05-29',
      fee: 9214,
      transfers: [
        { counterparty: 'bc1qy0rlysheyqwrjhs6e8ya82urst9d479wa24mrn', amount: -10000 },
        { counterparty: RECEIVER, amount: -146435 },
        { counterparty: 'bc1q9rxk6kyv3lky39mtysl0hjjwvuauzfrt0m2mk7', amount: -238474212 },
      ],
    });
  });

  it('reads the same payment from the receiver side', () => {
    expect(toChainTx(real, RECEIVER)).toEqual({
      txid: real.txid,
      date: '2026-05-29',
      fee: 0,
      transfers: [{ counterparty: SENDER, amount: 146435 }],
    });
  });

  it('does not count change back to the address as money leaving', () => {
    const t = tx('c', [[S, 100000]], [['bc1qext', 60000], [S, 39000]], 1000);
    expect(toChainTx(t, S)).toMatchObject({ fee: 1000, transfers: [{ counterparty: 'bc1qext', amount: -60000 }] });
  });

  it('reduces a consolidation to its fee', () => {
    const t = tx('k', [[S, 60000], [S, 40000]], [[S, 99000]], 1000);
    expect(toChainTx(t, S)).toMatchObject({ fee: 1000, transfers: [] });
  });

  it('sums several outputs to the address when receiving', () => {
    const t = tx('r', [['bc1qfrom', 50000]], [[S, 1000], [S, 2000], ['bc1qother', 46000]], 1000);
    expect(toChainTx(t, S)).toMatchObject({ fee: 0, transfers: [{ counterparty: 'bc1qfrom', amount: 3000 }] });
  });
});

describe('bitcoinProvider.fetchNewTxs', () => {
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
  });
  afterAll(() => {
    global.fetch = originalFetch;
  });

  const respond = (status: number, body: unknown) =>
    Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body } as Response);
  const page = (prefix: string, n: number) =>
    Array.from({ length: n }, (_, i) => tx(`${prefix}${i}`, [['bc1qfrom', 10]], [[S, 10]]));

  it('pages newest-first and returns only unknown txs, oldest first', async () => {
    const first = page('a', 25);
    const second = page('b', 3);
    fetchMock.mockImplementation((url: string) =>
      respond(200, url.endsWith(`/txs/chain/${first[24].txid}`) ? second : first)
    );

    const result = await bitcoinProvider.fetchNewTxs(S, new Set(['b2']));

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[0][0]).toBe(`https://mempool.space/api/address/${S}/txs/chain`);
    expect(fetchMock.mock.calls[1][0]).toBe(`https://mempool.space/api/address/${S}/txs/chain/a24`);
    expect(result.map(t => t.txid)).toEqual(['b1', 'b0', ...first.map(t => t.txid).reverse()]);
  });

  it('stops at the first page that is entirely known', async () => {
    const first = page('a', 25);
    fetchMock.mockImplementation(() => respond(200, first));

    const known = new Set(first.map(t => t.txid));
    await expect(bitcoinProvider.fetchNewTxs(S, known)).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('uses BITCOIN_ESPLORA_URL when set', async () => {
    process.env.BITCOIN_ESPLORA_URL = 'https://esplora.test/api';
    fetchMock.mockImplementation(() => respond(200, []));
    try {
      await bitcoinProvider.fetchNewTxs(S, new Set());
      expect(fetchMock.mock.calls[0][0]).toBe(`https://esplora.test/api/address/${S}/txs/chain`);
    } finally {
      delete process.env.BITCOIN_ESPLORA_URL;
    }
  });

  it('maps an Esplora 400 to Invalid address', async () => {
    fetchMock.mockImplementation(() => respond(400, 'Invalid Bitcoin address'));
    await expect(bitcoinProvider.fetchNewTxs('nope', new Set()))
      .rejects.toEqual({ statusCode: 400, message: 'Invalid address' });
  });

  it.each([429, 500, 503])('maps HTTP %i to 502', async status => {
    fetchMock.mockImplementation(() => respond(status, 'busy'));
    await expect(bitcoinProvider.fetchNewTxs(S, new Set()))
      .rejects.toEqual({ statusCode: 502, message: 'Blockchain API unavailable' });
  });

  it('maps a network failure or timeout to 502', async () => {
    fetchMock.mockImplementation(() => Promise.reject(new Error('The operation was aborted due to timeout')));
    await expect(bitcoinProvider.fetchNewTxs(S, new Set()))
      .rejects.toEqual({ statusCode: 502, message: 'Blockchain API unavailable' });
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `cd backend && npx jest --testPathPatterns=bitcoinProvider`
Expected: FAIL — `Cannot find module '../services/chain/bitcoin'`.

- [ ] **Step 4: Write the types**

`backend/src/services/chain/types.ts`:

```ts
/**
 * One counterparty's net movement in a transaction, in the chain's base unit
 * (satoshis for Bitcoin): positive = received from it, negative = sent to it.
 * Plain numbers are safe — all bitcoin ever is 2.1e15 sats, well inside
 * Number's integer range.
 */
export interface ChainTransfer {
  counterparty: string;
  amount: number;
}

/**
 * An on-chain transaction as seen from one address. Chain specifics (UTXOs,
 * change outputs, gas) stay in the provider; sync only reads this shape.
 */
export interface ChainTx {
  txid: string;
  /** YYYY-MM-DD, UTC date of the block. */
  date: string;
  /** Fee paid by this address; 0 when it did not pay. */
  fee: number;
  transfers: ChainTransfer[];
}

export interface ChainProvider {
  /** Native currency, e.g. 'BTC'. A tracked account must use it. */
  currency: string;
  /** Decimal places of the base unit, e.g. 8 for satoshis. */
  scale: number;
  /** Confirmed transactions of `address` not in `known`, oldest first. */
  fetchNewTxs(address: string, known: ReadonlySet<string>): Promise<ChainTx[]>;
}
```

- [ ] **Step 5: Write the provider**

`backend/src/services/chain/bitcoin.ts`:

```ts
import { ChainProvider, ChainTransfer, ChainTx } from './types';

/** The parts of an Esplora transaction this provider reads. */
export interface EsploraTx {
  txid: string;
  fee: number;
  status: { confirmed: boolean; block_time?: number };
  // prevout is null for a coinbase input.
  vin: { prevout: { scriptpubkey_address?: string; value: number } | null }[];
  vout: { scriptpubkey_address?: string; value: number }[];
}

// Esplora's fixed page size for /txs/chain.
const PAGE_SIZE = 25;
const TIMEOUT_MS = 10_000;

const baseUrl = () => process.env.BITCOIN_ESPLORA_URL || 'https://mempool.space/api';
const unavailable = () => ({ statusCode: 502, message: 'Blockchain API unavailable' });

async function getJson<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${baseUrl()}${path}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch {
    throw unavailable();
  }
  // Esplora answers 400 "Invalid Bitcoin address" for a malformed address;
  // anything else that is not OK (429 rate limit, 5xx) is the API's problem.
  if (res.status === 400) throw { statusCode: 400, message: 'Invalid address' };
  if (!res.ok) throw unavailable();
  return (await res.json()) as T;
}

/**
 * A confirmed transaction as seen from `address`.
 *
 * Bitcoin has no "from/to": a transaction spends inputs and creates outputs.
 * If none of the inputs is ours we received — the sum of outputs to us, from
 * the first input's address (a UTXO cannot say which input paid which
 * output). If any input is ours we paid, and every output not back to us is
 * money leaving; outputs back to us are change, not a movement.
 */
export function toChainTx(tx: EsploraTx, address: string): ChainTx {
  const date = new Date(tx.status.block_time! * 1000).toISOString().slice(0, 10);
  const spent = tx.vin.some(i => i.prevout?.scriptpubkey_address === address);

  if (!spent) {
    const received = tx.vout
      .filter(o => o.scriptpubkey_address === address)
      .reduce((sum, o) => sum + o.value, 0);
    const from = tx.vin.find(i => i.prevout?.scriptpubkey_address)?.prevout?.scriptpubkey_address ?? '';
    return { txid: tx.txid, date, fee: 0, transfers: [{ counterparty: from, amount: received }] };
  }

  const transfers: ChainTransfer[] = tx.vout
    .filter(o => o.scriptpubkey_address !== address && o.value > 0)
    .map(o => ({ counterparty: o.scriptpubkey_address ?? '', amount: -o.value }));
  return { txid: tx.txid, date, fee: tx.fee, transfers };
}

export const bitcoinProvider: ChainProvider = {
  currency: 'BTC',
  scale: 8,

  async fetchNewTxs(address, known) {
    const base = `/address/${encodeURIComponent(address)}/txs/chain`;
    const fresh: EsploraTx[] = [];
    let path = base;
    for (;;) {
      const page = await getJson<EsploraTx[]>(path);
      const unseen = page.filter(t => !known.has(t.txid));
      fresh.push(...unseen);
      // Pages run newest first, and a sync writes all of its txs or none, so
      // a page with nothing new means everything older is already stored.
      if (page.length < PAGE_SIZE || unseen.length === 0) break;
      path = `${base}/${page[page.length - 1].txid}`;
    }
    // Oldest first, so rows are inserted in the order they happened.
    return fresh.reverse().map(t => toChainTx(t, address));
  },
};
```

- [ ] **Step 6: Run the tests**

Run: `cd backend && npx jest --testPathPatterns=bitcoinProvider`
Expected: PASS (all).

- [ ] **Step 7: Commit**

```bash
git add backend/src/services/chain backend/src/test/bitcoinProvider.test.ts backend/src/test/fixtures/chain
git commit -m "feat(sync): Bitcoin provider over the Esplora API

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Provider registry and tracked-account rules

**Files:**
- Create: `backend/src/services/chain/index.ts`
- Modify: `backend/src/types/index.ts` (`Account`)
- Modify: `backend/src/services/accounts.ts`
- Test: `backend/src/test/trackedAccounts.test.ts`

**Interfaces:**
- Consumes: `bitcoinProvider`, `ChainProvider` (Task 2).
- Produces:
  ```ts
  // services/chain/index.ts
  export type { ChainProvider, ChainTx, ChainTransfer } from './types';
  export function getProvider(blockchain: unknown): ChainProvider | null;
  export function isTracked(account: Pick<Account, 'type' | 'settings'>): boolean;
  ```
  Account DTOs (`GET/POST/PUT /api/accounts`) carry `tracked: boolean`.

- [ ] **Step 1: Write the failing tests**

`backend/src/test/trackedAccounts.test.ts`:

```ts
import request from 'supertest';
import { createTestApp } from './testApp';
import { pool } from '../db';

const app = createTestApp();
const WALLET = { type: 'crypto', settings: { address: 'bc1qtracked', blockchain: 'bitcoin' } };

describe('Tracked (blockchain-synced) accounts', () => {
  let token: string;
  let userId: number;
  const auth = () => ({ Authorization: `Bearer ${token}` });

  // Account DTOs convert balances through the rates API; keep it offline.
  const originalFetch = global.fetch;
  beforeAll(() => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ date: new Date().toISOString().slice(0, 10), rates: {} }),
    }) as unknown as typeof fetch;
  });
  afterAll(() => {
    global.fetch = originalFetch;
  });

  beforeAll(async () => {
    const email = `tracked${Date.now()}@example.com`;
    const res = await request(app).post('/api/auth/register').send({ email, password: 'password123' });
    token = res.body.data.accessToken;
    userId = (await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM transactions WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM accounts WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM categories WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  });

  const create = (body: object) => request(app).post('/api/accounts').set(auth()).send(body);
  const update = (id: number, body: object) => request(app).put(`/api/accounts/${id}`).set(auth()).send(body);
  const addTransaction = (accountId: number) =>
    pool.query(
      `INSERT INTO transactions (user_id, category_id, credit_account_id, debit, credit, date)
       VALUES ($1, 3, $2, 100, 100, '2026-01-01')`,
      [userId, accountId]
    );

  describe('create', () => {
    it('creates a tracked wallet at scale 8 and flags it', async () => {
      const res = await create({ name: 'Cold', currency: 'BTC', startBalance: 0, ...WALLET });
      expect(res.status).toBe(200);
      expect(res.body.data.tracked).toBe(true);
      expect(res.body.data.scale).toBe(8);
    });

    it('rejects a non-zero start balance', async () => {
      const res = await create({ name: 'Cold', currency: 'BTC', startBalance: 1, ...WALLET });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/starts at 0/);
    });

    it("rejects a currency other than the chain's", async () => {
      const res = await create({ name: 'Cold', currency: 'EUR', startBalance: 0, ...WALLET });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/BTC/);
    });

    it('leaves a crypto account without an address untracked', async () => {
      const res = await create({
        name: 'Exchange', currency: 'BTC', startBalance: 5, type: 'crypto', settings: { blockchain: 'bitcoin' },
      });
      expect(res.status).toBe(200);
      expect(res.body.data.tracked).toBe(false);
    });

    it('leaves an unsupported chain untracked', async () => {
      const res = await create({
        name: 'Eth', currency: 'ETH', startBalance: 5, type: 'crypto', settings: { address: '0xabc', blockchain: 'ethereum' },
      });
      expect(res.status).toBe(200);
      expect(res.body.data.tracked).toBe(false);
    });

    it('flags accounts in GET /api/accounts', async () => {
      const created = await create({ name: 'Listed', currency: 'BTC', startBalance: 0, ...WALLET });
      const res = await request(app).get('/api/accounts').set(auth());
      const listed = res.body.data.find((a: any) => a.id === created.body.data.id);
      expect(listed.tracked).toBe(true);
    });
  });

  describe('update', () => {
    it('makes an empty, zero-balance account tracked', async () => {
      const plain = await create({ name: 'Later', currency: 'BTC', startBalance: 0, type: 'crypto', settings: {} });
      const res = await update(plain.body.data.id, { name: 'Later', currency: 'BTC', startBalance: 0, ...WALLET });
      expect(res.status).toBe(200);
      expect(res.body.data.tracked).toBe(true);
      expect(res.body.data.scale).toBe(8);
    });

    it('refuses to track an account that has transactions', async () => {
      const plain = await create({ name: 'Used', currency: 'BTC', startBalance: 0, type: 'crypto', settings: {} });
      await addTransaction(plain.body.data.id);
      const res = await update(plain.body.data.id, { name: 'Used', currency: 'BTC', startBalance: 0, ...WALLET });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/create a new account/);
    });

    it('refuses to track an account with a start balance', async () => {
      const plain = await create({ name: 'Funded', currency: 'BTC', startBalance: 1, type: 'crypto', settings: {} });
      const res = await update(plain.body.data.id, { name: 'Funded', currency: 'BTC', startBalance: 0, ...WALLET });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/create a new account/);
    });

    it('refuses a start balance change on a tracked account', async () => {
      const w = await create({ name: 'W1', currency: 'BTC', startBalance: 0, ...WALLET });
      const res = await update(w.body.data.id, { name: 'W1', currency: 'BTC', startBalance: 2, ...WALLET });
      expect(res.status).toBe(400);
    });

    it('allows renaming a tracked account that has transactions', async () => {
      const w = await create({ name: 'W2', currency: 'BTC', startBalance: 0, ...WALLET });
      await addTransaction(w.body.data.id);
      const res = await update(w.body.data.id, { name: 'W2 renamed', currency: 'BTC', startBalance: 0, ...WALLET });
      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('W2 renamed');
    });

    it('refuses an address change once transactions exist', async () => {
      const w = await create({ name: 'W3', currency: 'BTC', startBalance: 0, ...WALLET });
      await addTransaction(w.body.data.id);
      const res = await update(w.body.data.id, {
        name: 'W3', currency: 'BTC', startBalance: 0, type: 'crypto', settings: { address: 'bc1qother', blockchain: 'bitcoin' },
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/wallet/);
    });

    it('allows an address change while the account is empty', async () => {
      const w = await create({ name: 'W4', currency: 'BTC', startBalance: 0, ...WALLET });
      const res = await update(w.body.data.id, {
        name: 'W4', currency: 'BTC', startBalance: 0, type: 'crypto', settings: { address: 'bc1qother', blockchain: 'bitcoin' },
      });
      expect(res.status).toBe(200);
      expect(res.body.data.settings.address).toBe('bc1qother');
    });

    it('untracks by removing the address, keeping transactions', async () => {
      const w = await create({ name: 'W5', currency: 'BTC', startBalance: 0, ...WALLET });
      await addTransaction(w.body.data.id);
      const res = await update(w.body.data.id, {
        name: 'W5', currency: 'BTC', startBalance: 0, type: 'crypto', settings: { blockchain: 'bitcoin' },
      });
      expect(res.status).toBe(200);
      expect(res.body.data.tracked).toBe(false);
      const count = await pool.query('SELECT COUNT(*)::int AS n FROM transactions WHERE credit_account_id = $1', [w.body.data.id]);
      expect(count.rows[0].n).toBe(1);
    });
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && npx jest --testPathPatterns=trackedAccounts`
Expected: FAIL — `tracked` undefined, non-zero start balance accepted, etc.

- [ ] **Step 3: Write the registry**

`backend/src/services/chain/index.ts`:

```ts
import type { Account } from '../../types';
import type { ChainProvider } from './types';
import { bitcoinProvider } from './bitcoin';

export type { ChainProvider, ChainTx, ChainTransfer } from './types';

// Keyed by the value stored in accounts.settings.blockchain.
const PROVIDERS = new Map<string, ChainProvider>([['bitcoin', bitcoinProvider]]);

/** The provider for a `settings.blockchain` value, or null when unsupported. */
export function getProvider(blockchain: unknown): ChainProvider | null {
  return typeof blockchain === 'string' ? PROVIDERS.get(blockchain) ?? null : null;
}

/**
 * A crypto account whose transactions come from the blockchain: it names an
 * address on a chain we have a provider for. Anything else — including a
 * crypto account without an address, such as an exchange balance — is an
 * ordinary, hand-edited account.
 */
export function isTracked(account: Pick<Account, 'type' | 'settings'>): boolean {
  const { address, blockchain } = account.settings as { address?: unknown; blockchain?: unknown };
  return account.type === 'crypto'
    && typeof address === 'string'
    && address !== ''
    && getProvider(blockchain) !== null;
}
```

- [ ] **Step 4: Add `tracked` to the Account type**

In `backend/src/types/index.ts`, inside `interface Account`, after `owner_name?: string;`:

```ts
  /** Transactions come from the blockchain; set by services/accounts.ts. */
  tracked?: boolean;
```

- [ ] **Step 5: Enforce the rules in the account service**

In `backend/src/services/accounts.ts`:

Add the import:
```ts
import { ChainProvider, getProvider, isTracked } from './chain';
```

In `toDecimalDTO`, add `tracked` to the returned object:
```ts
function toDecimalDTO(account: Account, userScale: number): Account {
  return {
    ...account,
    start_balance: toDecimal(account.start_balance, account.scale),
    balance: toDecimal(account.balance, account.scale),
    user_balance: account.user_balance != null ? toDecimal(account.user_balance, userScale) : account.user_balance,
    tracked: isTracked(account),
  };
}
```

Add below `getUserOrThrow`:
```ts
/**
 * A synced account's balance comes only from the chain, so it starts at 0
 * and is kept in the chain's own currency.
 */
function assertTrackedShape(provider: ChainProvider, currency: string, startBalance: number | undefined): void {
  if (startBalance != null && startBalance !== 0) {
    throw { statusCode: 400, message: 'A blockchain-synced account starts at 0; its balance comes from the chain' };
  }
  if (currency !== provider.currency) {
    throw { statusCode: 400, message: `A blockchain-synced account must be in ${provider.currency}` };
  }
}
```

In `createAccount`, right after `const user = await getUserOrThrow(userId);`:
```ts
  const provider = isTracked({ type, settings }) ? getProvider(settings.blockchain) : null;
  if (provider) {
    assertTrackedShape(provider, currency, startBalance);
    scale = provider.scale;
  }
```

In `updateAccount`, replace the block from `const user = await getUserOrThrow(userId);` through `const account = await accountQueries.updateAccount(id, { ...data, startBalance });` with:
```ts
  const user = await getUserOrThrow(userId);

  let scale = data.scale;
  const provider = isTracked(data) ? getProvider(data.settings.blockchain) : null;
  if (provider) {
    assertTrackedShape(provider, data.currency ?? existing.currency, data.startBalance);
    scale = provider.scale;
    // Rows already on the account came from somewhere else — by hand, or from
    // another wallet — and would be mixed into this wallet's history.
    const wasTracked = isTracked(existing);
    const sameWallet = wasTracked
      && existing.settings.address === data.settings.address
      && existing.settings.blockchain === data.settings.blockchain;
    if (!sameWallet && (Number(existing.start_balance) !== 0 || await accountQueries.hasTransactions(id))) {
      throw {
        statusCode: 400,
        message: wasTracked
          ? 'Cannot change the wallet of an account that already has transactions'
          : 'Only an empty account with a zero start balance can be synced from a blockchain; create a new account',
      };
    }
  }

  const startBalance = data.startBalance != null
    ? toCents(data.startBalance, scale ?? existing.scale)
    : undefined;
  const account = await accountQueries.updateAccount(id, { ...data, scale, startBalance });
```

- [ ] **Step 6: Run the tests**

Run: `cd backend && npx jest --testPathPatterns="trackedAccounts|accounts"`
Expected: PASS (new file and the existing `accounts.test.ts`).

- [ ] **Step 7: Commit**

```bash
git add backend/src/services/chain/index.ts backend/src/types/index.ts backend/src/services/accounts.ts backend/src/test/trackedAccounts.test.ts
git commit -m "feat(accounts): rules for blockchain-synced accounts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Transaction and import rules for synced accounts

**Files:**
- Modify: `backend/src/services/transactions.ts`
- Modify: `backend/src/services/import/index.ts` (`loadWritableAccount`)
- Test: `backend/src/test/syncedTransactions.test.ts`

**Interfaces:**
- Consumes: `isTracked` (Task 3).
- Produces: `POST /api/transactions` → 403 when either account is tracked; `DELETE` → 403 on a synced row; `PUT` → 400 for any change outside rule 2 (`SYNCED_MESSAGE` = `'Transactions of this account are loaded from the blockchain'`); import parse/reconcile → 403 on a tracked account.

- [ ] **Step 1: Write the failing tests**

`backend/src/test/syncedTransactions.test.ts`:

```ts
import request from 'supertest';
import { createTestApp } from './testApp';
import { pool } from '../db';

const app = createTestApp();

describe('Transactions on synced accounts', () => {
  let token: string;
  let userId: number;
  let walletA: number;   // tracked BTC
  let walletB: number;   // tracked BTC
  let exchange: number;  // ordinary BTC
  let euro: number;      // ordinary EUR
  let myExpenseCategory: number;
  const auth = () => ({ Authorization: `Bearer ${token}` });

  const account = async (name: string, currency: string, scale: number, type: string, settings: object) =>
    (await pool.query(
      `INSERT INTO accounts (user_id, name, currency, scale, start_balance, type, settings)
       VALUES ($1, $2, $3, $4, 0, $5, $6) RETURNING id`,
      [userId, name, currency, scale, type, JSON.stringify(settings)]
    )).rows[0].id as number;

  const row = async (fields: {
    debit?: number | null; credit?: number | null; amount: number; category?: number | null; hash?: string | null; payee?: string | null;
  }) =>
    (await pool.query(
      `INSERT INTO transactions (user_id, category_id, debit_account_id, credit_account_id, debit, credit, date, payee, import_hash)
       VALUES ($1, $2, $3, $4, $5, $5, '2026-05-29', $6, $7) RETURNING id`,
      [userId, fields.category ?? null, fields.debit ?? null, fields.credit ?? null, fields.amount, fields.payee ?? null, fields.hash ?? null]
    )).rows[0].id as number;

  beforeAll(async () => {
    const email = `synctx${Date.now()}@example.com`;
    const res = await request(app).post('/api/auth/register').send({ email, password: 'password123' });
    token = res.body.data.accessToken;
    userId = (await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id;
    walletA = await account('A', 'BTC', 8, 'crypto', { address: 'bc1qa', blockchain: 'bitcoin' });
    walletB = await account('B', 'BTC', 8, 'crypto', { address: 'bc1qb', blockchain: 'bitcoin' });
    exchange = await account('Exchange', 'BTC', 8, 'crypto', {});
    euro = await account('Euro', 'EUR', 2, 'bank', {});
    myExpenseCategory = (await pool.query(
      'SELECT id FROM categories WHERE user_id = $1 AND parent_id = 2 LIMIT 1', [userId]
    )).rows[0].id;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM transactions WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM accounts WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM categories WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM transactions WHERE user_id = $1', [userId]);
  });

  // An expense of 0.001 BTC (100000 sats) synced onto wallet A.
  const syncedExpense = () => row({ debit: walletA, amount: 100000, category: 4, hash: 'tx1', payee: 'bc1qshop' });
  // What the edit form submits for it, unchanged.
  const unchanged = {
    debitAccountId: undefined as number | undefined, creditAccountId: null as number | null,
    debit: 0.001, credit: 0.001, categoryId: 4, date: '2026-05-29', payee: 'bc1qshop', description: null,
  };
  const put = (id: number, body: object) => request(app).put(`/api/transactions/${id}`).set(auth()).send(body);

  describe('create and delete', () => {
    it('refuses creating a transaction on a synced account', async () => {
      const res = await request(app).post('/api/transactions').set(auth())
        .send({ debitAccountId: walletA, debit: 0.001, credit: 0.001, date: '2026-05-29' });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Transactions of this account are loaded from the blockchain');
    });

    it('refuses a hand-made transfer into a synced account', async () => {
      const res = await request(app).post('/api/transactions').set(auth())
        .send({ debitAccountId: exchange, creditAccountId: walletA, debit: 0.001, credit: 0.001, date: '2026-05-29' });
      expect(res.status).toBe(403);
    });

    it('refuses deleting a synced transaction', async () => {
      const id = await syncedExpense();
      const res = await request(app).delete(`/api/transactions/${id}`).set(auth());
      expect(res.status).toBe(403);
    });

    it('still creates ordinary transactions', async () => {
      const res = await request(app).post('/api/transactions').set(auth())
        .send({ debitAccountId: exchange, debit: 0.001, credit: 0.001, date: '2026-05-29' });
      expect(res.status).toBe(200);
    });
  });

  describe('update of a one-sided synced row', () => {
    it('accepts an unchanged full payload', async () => {
      const id = await syncedExpense();
      const res = await put(id, { ...unchanged, debitAccountId: walletA });
      expect(res.status).toBe(200);
    });

    it('allows changing the category and description', async () => {
      const id = await syncedExpense();
      const res = await put(id, { ...unchanged, debitAccountId: walletA, categoryId: myExpenseCategory, description: 'coffee' });
      expect(res.status).toBe(200);
      expect(res.body.data.category.id).toBe(myExpenseCategory);
      expect(res.body.data.description).toBe('coffee');
    });

    it('allows turning it into a transfer to an ordinary account in the same currency', async () => {
      const id = await syncedExpense();
      const res = await put(id, { ...unchanged, debitAccountId: walletA, creditAccountId: exchange, categoryId: null });
      expect(res.status).toBe(200);
      expect(res.body.data.credit_account.id).toBe(exchange);
    });

    it('allows a transfer to another currency with its own amount', async () => {
      const id = await syncedExpense();
      const res = await put(id, { ...unchanged, debitAccountId: walletA, creditAccountId: euro, credit: 55.5, categoryId: null });
      expect(res.status).toBe(200);
      expect(res.body.data.credit).toBe(55.5);
    });

    it.each([
      ['date', { date: '2026-05-30' }],
      ['synced amount', { debit: 0.002, credit: 0.002 }],
      ['payee', { payee: 'someone else' }],
    ])('refuses changing the %s', async (_label, change) => {
      const id = await syncedExpense();
      const res = await put(id, { ...unchanged, debitAccountId: walletA, ...change });
      expect(res.status).toBe(400);
    });

    it('refuses moving it off the synced account', async () => {
      const id = await syncedExpense();
      const res = await put(id, { ...unchanged, debitAccountId: exchange });
      expect(res.status).toBe(400);
    });

    it('refuses pointing the other side at another synced account', async () => {
      const id = await syncedExpense();
      const res = await put(id, { ...unchanged, debitAccountId: walletA, creditAccountId: walletB, categoryId: null });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/sync only/);
    });
  });

  describe('update of a transfer between two synced wallets', () => {
    const transfer = () => row({ debit: walletA, credit: walletB, amount: 7000, hash: 'tx2', payee: 'bc1qb' });
    const same = () => ({
      debitAccountId: walletA, creditAccountId: walletB, debit: 0.00007, credit: 0.00007,
      categoryId: null, date: '2026-05-29', payee: 'bc1qb',
    });

    it('allows the description', async () => {
      const id = await transfer();
      const res = await put(id, { ...same(), description: 'to cold storage' });
      expect(res.status).toBe(200);
    });

    it('refuses replacing either wallet', async () => {
      const id = await transfer();
      const res = await put(id, { ...same(), creditAccountId: exchange });
      expect(res.status).toBe(400);
    });
  });

  it('refuses moving an ordinary transaction onto a synced account', async () => {
    const id = await row({ debit: exchange, amount: 100000, category: 4 });
    const res = await put(id, { debitAccountId: walletA });
    expect(res.status).toBe(403);
  });

  it('refuses a statement import into a synced account', async () => {
    const res = await request(app).post('/api/import/parse').set(auth())
      .send({ accountId: walletA, content: Buffer.from('x').toString('base64') });
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && npx jest --testPathPatterns=syncedTransactions`
Expected: FAIL — creates/deletes succeed, forbidden edits return 200.

- [ ] **Step 3: Implement in the transaction service**

In `backend/src/services/transactions.ts`:

Change the types import and add the chain import:
```ts
import { Account, Transaction, TransactionDTO } from '../types';
import { isTracked } from './chain';
```

Below the `UNCATEGORIZED_*` constants add:
```ts
const SYNCED_MESSAGE = 'Transactions of this account are loaded from the blockchain';

/** Which of these accounts are synced from a blockchain. */
async function trackedAmong(accountIds: (number | null | undefined)[]): Promise<Set<number>> {
  const ids = [...new Set(accountIds.filter((id): id is number => id != null))];
  const accounts = await accountQueries.getAccountsByIds(ids);
  return new Set(accounts.filter(isTracked).map(a => a.id));
}

/**
 * A transaction on a blockchain-synced account records what the chain says:
 * the date, the synced side's account and amount, and the payee address are
 * fixed. The user may still categorise it, point its other side at an
 * ordinary account (turning it into a transfer or back), set that side's
 * amount when the currencies differ — validateTransactionInput already
 * forces it equal otherwise — and edit the description. With both sides
 * synced, that leaves only the description.
 *
 * `next` is the validated update, amounts already in cents. Stored NUMERIC
 * amounts arrive from pg as strings, hence Number().
 */
function assertSyncedEdit(existing: Transaction, next: CreateInput, tracked: Set<number>): void {
  const debitSynced = existing.debit_account_id != null && tracked.has(existing.debit_account_id);
  const creditSynced = existing.credit_account_id != null && tracked.has(existing.credit_account_id);

  if (!debitSynced && !creditSynced) {
    if ([next.debitAccountId, next.creditAccountId].some(id => id != null && tracked.has(id))) {
      throw { statusCode: 403, message: SYNCED_MESSAGE };
    }
    return;
  }

  const refuse = (what: string) => {
    throw { statusCode: 400, message: `${SYNCED_MESSAGE}; its ${what} cannot be changed` };
  };
  if (next.date !== existing.date) refuse('date');
  if ((next.payee ?? '') !== (existing.payee ?? '')) refuse('payee');
  if (debitSynced && (next.debitAccountId !== existing.debit_account_id || next.debit !== Number(existing.debit))) {
    refuse('account or amount');
  }
  if (creditSynced && (next.creditAccountId !== existing.credit_account_id || next.credit !== Number(existing.credit))) {
    refuse('account or amount');
  }

  const other = debitSynced && creditSynced ? null : debitSynced ? next.creditAccountId : next.debitAccountId;
  if (other != null && tracked.has(other)) {
    throw { statusCode: 400, message: 'A transfer between two synced accounts is created by sync only' };
  }
}
```

(If `Account` becomes unused in this file, drop it from the import rather than leave it.)

In `createTransaction`, before `validateTransactionInput`:
```ts
  if ((await trackedAmong([input.debitAccountId, input.creditAccountId])).size > 0) {
    throw { statusCode: 403, message: SYNCED_MESSAGE };
  }
```

In `updateTransaction`, replace `await validateTransactionInput(merged, userId, existing.user_id);` with:
```ts
  await validateTransactionInput(merged, userId, existing.user_id);
  assertSyncedEdit(
    existing,
    merged,
    await trackedAmong([existing.debit_account_id, existing.credit_account_id, merged.debitAccountId, merged.creditAccountId])
  );
```

In `deleteTransaction`, after `requireLevelOnAll(...)`:
```ts
  if ((await trackedAmong([existing.debit_account_id, existing.credit_account_id])).size > 0) {
    throw { statusCode: 403, message: SYNCED_MESSAGE };
  }
```

- [ ] **Step 4: Refuse import into a tracked account**

In `backend/src/services/import/index.ts`, add `import { isTracked } from '../chain';` and in `loadWritableAccount`, after `await requireLevel(accountId, userId, LEVEL.WRITE);`:
```ts
  if (isTracked(account)) {
    throw { statusCode: 403, message: 'Transactions of this account are loaded from the blockchain' };
  }
```

- [ ] **Step 5: Run the tests**

Run: `cd backend && npx jest --testPathPatterns="syncedTransactions|transactions|import|sharing"`
Expected: PASS (new file plus existing transaction, import and sharing suites).

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/transactions.ts backend/src/services/import/index.ts backend/src/test/syncedTransactions.test.ts
git commit -m "feat(transactions): lock chain-stated fields on synced accounts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Sync service

**Files:**
- Modify: `backend/src/db/queries/transactions.ts` (append sync queries)
- Create: `backend/src/services/chainSync.ts`
- Test: `backend/src/test/chainSync.test.ts`

**Interfaces:**
- Consumes: `getProvider`, `isTracked`, `ChainTx` (Task 3); `bitcoinProvider` (Task 2, spied on in tests); `withTransaction`, `Tx` from `db/index.ts`; `suggestCategories` from `services/import/categorize.ts`; `getTreeCategoryIds`, `resolveCategoryForOwner` from `services/categories.ts`.
- Produces:
  ```ts
  // services/chainSync.ts
  export interface SyncResult { added: number; merged: number; fees: number }
  export interface Plan { … }  // see code
  export function planTx(tx: ChainTx, peers: ReadonlyMap<string, Account>): Plan;
  export const syncAccount: (userId: number, accountId: number) => Promise<SyncResult>;
  // db/queries/transactions.ts
  export const findSyncedTxids: (accountId: number) => Promise<string[]>;
  export const findByImportHashForUpdate: (db: Tx, accountId: number, side: 'debit' | 'credit', hash: string) => Promise<Transaction | null>;
  export const setSyncedShape: (db: Tx, id: number, shape: SyncedShape) => Promise<void>;
  export const insertSynced: (db: Tx, userId: number, row: ImportedTransactionData) => Promise<boolean>;
  ```

- [ ] **Step 1: Write the failing tests**

`backend/src/test/chainSync.test.ts`:

```ts
import request from 'supertest';
import { createTestApp } from './testApp';
import { pool } from '../db';
import { bitcoinProvider } from '../services/chain/bitcoin';
import { ChainTx } from '../services/chain';
import { planTx, syncAccount } from '../services/chainSync';
import { Account } from '../types';

const app = createTestApp();

describe('planTx', () => {
  const peer = { id: 9 } as Account;
  const peers = new Map([['bc1qpeer', peer]]);
  const base = { txid: 't', date: '2026-05-29' };

  it('files a receipt as income from the first sender', () => {
    const plan = planTx({ ...base, fee: 0, transfers: [{ counterparty: 'bc1qx', amount: 5000 }] }, peers);
    expect(plan).toEqual({ ...base, fee: 0, income: { amount: 5000, from: 'bc1qx', peer: undefined } });
  });

  it('marks a receipt from a synced wallet', () => {
    const plan = planTx({ ...base, fee: 0, transfers: [{ counterparty: 'bc1qpeer', amount: 5000 }] }, peers);
    expect(plan.income?.peer).toBe(peer);
  });

  it('splits a payment into transfer, expense and fee', () => {
    const plan = planTx({
      ...base, fee: 100, transfers: [
        { counterparty: 'bc1qx', amount: -1000 },
        { counterparty: 'bc1qpeer', amount: -7000 },
        { counterparty: 'bc1qpeer', amount: -500 },
        { counterparty: 'bc1qy', amount: -2000 },
      ],
    }, peers);
    expect(plan).toEqual({
      ...base, fee: 100,
      transfer: { amount: 7500, peer },
      expense: { amount: 3000, to: 'bc1qx' },
    });
  });

  it('reduces a consolidation to its fee', () => {
    expect(planTx({ ...base, fee: 300, transfers: [] }, peers)).toEqual({ ...base, fee: 300 });
  });
});

describe('syncAccount', () => {
  let userId: number;
  let otherUserId: number;
  let walletA: number;
  let walletB: number;
  let exchange: number;
  let shop: number;
  let spy: jest.SpyInstance;
  // Per-address histories the mocked provider serves, filtered by `known`
  // exactly like the real one.
  const history = new Map<string, ChainTx[]>();

  const register = async (prefix: string) => {
    const email = `${prefix}${Date.now()}@example.com`;
    await request(app).post('/api/auth/register').send({ email, password: 'password123' });
    return (await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id as number;
  };
  const wallet = async (owner: number, name: string, settings: object) =>
    (await pool.query(
      `INSERT INTO accounts (user_id, name, currency, scale, start_balance, type, settings)
       VALUES ($1, $2, 'BTC', 8, 0, 'crypto', $3) RETURNING id`,
      [owner, name, JSON.stringify(settings)]
    )).rows[0].id as number;
  const rows = async (accountId: number) =>
    (await pool.query(
      `SELECT debit_account_id, credit_account_id, debit::int, credit::int, category_id, payee, import_hash
       FROM transactions WHERE debit_account_id = $1 OR credit_account_id = $1 ORDER BY import_hash`,
      [accountId]
    )).rows;

  beforeAll(async () => {
    userId = await register('sync');
    otherUserId = await register('syncother');
    walletA = await wallet(userId, 'A', { address: 'bc1qa', blockchain: 'bitcoin' });
    walletB = await wallet(userId, 'B', { address: 'bc1qb', blockchain: 'bitcoin' });
    exchange = await wallet(userId, 'Exchange', {});
    shop = (await pool.query(
      'SELECT id FROM categories WHERE user_id = $1 AND parent_id = 2 LIMIT 1', [userId]
    )).rows[0].id;
    spy = jest.spyOn(bitcoinProvider, 'fetchNewTxs').mockImplementation(async (address, known) =>
      (history.get(address) ?? []).filter(t => !known.has(t.txid))
    );
  });

  afterAll(async () => {
    spy.mockRestore();
    for (const id of [userId, otherUserId]) {
      await pool.query('DELETE FROM transactions WHERE user_id = $1', [id]);
      await pool.query('DELETE FROM account_shares WHERE user_id = $1', [id]);
      await pool.query('DELETE FROM accounts WHERE user_id = $1', [id]);
      await pool.query('DELETE FROM categories WHERE user_id = $1', [id]);
      await pool.query('DELETE FROM users WHERE id = $1', [id]);
    }
  });

  beforeEach(async () => {
    history.clear();
    await pool.query('DELETE FROM transactions WHERE user_id = ANY($1::int[])', [[userId, otherUserId]]);
    await pool.query(
      `UPDATE accounts SET settings = $2, deleted = false WHERE id = $1`,
      [walletB, JSON.stringify({ address: 'bc1qb', blockchain: 'bitcoin' })]
    );
  });

  const tx = (txid: string, fee: number, transfers: [string, number][]): ChainTx =>
    ({ txid, date: '2026-05-29', fee, transfers: transfers.map(([counterparty, amount]) => ({ counterparty, amount })) });

  it('files a receipt as uncategorised income', async () => {
    history.set('bc1qa', [tx('r1', 0, [['bc1qx', 5000]])]);
    await expect(syncAccount(userId, walletA)).resolves.toEqual({ added: 1, merged: 0, fees: 0 });
    expect(await rows(walletA)).toEqual([
      { debit_account_id: null, credit_account_id: walletA, debit: 5000, credit: 5000, category_id: 3, payee: 'bc1qx', import_hash: 'r1' },
    ]);
  });

  it('files a payment as expense plus a Network fees row', async () => {
    history.set('bc1qa', [tx('p1', 200, [['bc1qx', -3000]])]);
    await expect(syncAccount(userId, walletA)).resolves.toEqual({ added: 1, merged: 0, fees: 1 });
    expect(await rows(walletA)).toEqual([
      { debit_account_id: walletA, credit_account_id: null, debit: 3000, credit: 3000, category_id: 4, payee: 'bc1qx', import_hash: 'p1' },
      { debit_account_id: walletA, credit_account_id: null, debit: 200, credit: 200, category_id: 5, payee: null, import_hash: 'p1:fee' },
    ]);
  });

  it('files a consolidation as its fee alone', async () => {
    history.set('bc1qa', [tx('k1', 300, [])]);
    await expect(syncAccount(userId, walletA)).resolves.toEqual({ added: 0, merged: 0, fees: 1 });
    expect(await rows(walletA)).toHaveLength(1);
  });

  it('files a payment to another synced wallet as one transfer, and re-sync is a no-op', async () => {
    history.set('bc1qa', [tx('t1', 100, [['bc1qb', -7000], ['bc1qx', -1000]])]);
    history.set('bc1qb', [tx('t1', 0, [['bc1qa', 7000]])]);

    await expect(syncAccount(userId, walletA)).resolves.toEqual({ added: 2, merged: 0, fees: 1 });
    await expect(syncAccount(userId, walletB)).resolves.toEqual({ added: 0, merged: 0, fees: 0 });
    await expect(syncAccount(userId, walletA)).resolves.toEqual({ added: 0, merged: 0, fees: 0 });

    expect(await rows(walletA)).toEqual([
      { debit_account_id: walletA, credit_account_id: walletB, debit: 7000, credit: 7000, category_id: null, payee: 'bc1qb', import_hash: 't1' },
      { debit_account_id: walletA, credit_account_id: null, debit: 100, credit: 100, category_id: 5, payee: null, import_hash: 't1:fee' },
      { debit_account_id: walletA, credit_account_id: null, debit: 1000, credit: 1000, category_id: 4, payee: 'bc1qx', import_hash: 't1:out' },
    ]);
  });

  it('merges into the receiver row when the receiver synced first', async () => {
    history.set('bc1qb', [tx('t2', 0, [['bc1qa', 7000]])]);
    history.set('bc1qa', [tx('t2', 100, [['bc1qb', -7000]])]);

    await expect(syncAccount(userId, walletB)).resolves.toEqual({ added: 1, merged: 0, fees: 0 });
    await expect(syncAccount(userId, walletA)).resolves.toEqual({ added: 0, merged: 1, fees: 1 });

    expect(await rows(walletB)).toEqual([
      { debit_account_id: walletA, credit_account_id: walletB, debit: 7000, credit: 7000, category_id: null, payee: 'bc1qa', import_hash: 't2' },
    ]);
  });

  it('overrides a hand-set transfer source on the receiver row', async () => {
    history.set('bc1qb', [tx('t3', 0, [['bc1qa', 7000]])]);
    history.set('bc1qa', [tx('t3', 100, [['bc1qb', -7000]])]);
    await syncAccount(userId, walletB);
    await pool.query(
      `UPDATE transactions SET debit_account_id = $1, category_id = NULL WHERE import_hash = 't3'`,
      [exchange]
    );

    await expect(syncAccount(userId, walletA)).resolves.toEqual({ added: 0, merged: 1, fees: 1 });
    const [merged] = await rows(walletB);
    expect(merged.debit_account_id).toBe(walletA);
  });

  it('merges into the sender row when the receiver became synced later, splitting off the rest', async () => {
    await pool.query(`UPDATE accounts SET settings = '{}' WHERE id = $1`, [walletB]);
    history.set('bc1qa', [tx('t4', 100, [['bc1qb', -7000], ['bc1qx', -1000]])]);
    await expect(syncAccount(userId, walletA)).resolves.toEqual({ added: 1, merged: 0, fees: 1 });
    await pool.query(`UPDATE transactions SET category_id = $1 WHERE import_hash = 't4'`, [shop]);

    await pool.query(
      `UPDATE accounts SET settings = $2 WHERE id = $1`,
      [walletB, JSON.stringify({ address: 'bc1qb', blockchain: 'bitcoin' })]
    );
    history.set('bc1qb', [tx('t4', 0, [['bc1qa', 7000]])]);
    await expect(syncAccount(userId, walletB)).resolves.toEqual({ added: 0, merged: 1, fees: 0 });

    expect(await rows(walletA)).toEqual([
      { debit_account_id: walletA, credit_account_id: walletB, debit: 7000, credit: 7000, category_id: null, payee: 'bc1qb', import_hash: 't4' },
      { debit_account_id: walletA, credit_account_id: null, debit: 100, credit: 100, category_id: 5, payee: null, import_hash: 't4:fee' },
      { debit_account_id: walletA, credit_account_id: null, debit: 1000, credit: 1000, category_id: shop, payee: 'bc1qb', import_hash: 't4:out' },
    ]);
  });

  it('suggests categories from history by payee', async () => {
    for (let i = 0; i < 3; i++) {
      await pool.query(
        `INSERT INTO transactions (user_id, category_id, debit_account_id, debit, credit, date, payee)
         VALUES ($1, $2, $3, 10, 10, '2026-01-01', 'bc1qshop')`,
        [userId, shop, exchange]
      );
    }
    history.set('bc1qa', [tx('s1', 0, [['bc1qshop', -500]])]);
    await syncAccount(userId, walletA);
    const [expense] = (await rows(walletA)).filter(r => r.import_hash === 's1');
    expect(expense.category_id).toBe(shop);
  });

  it('files rows with categories resolved for the owner when a co-user syncs', async () => {
    const otherCategory = (await pool.query(
      'SELECT id FROM categories WHERE user_id = $1 AND parent_id = 2 LIMIT 1', [otherUserId]
    )).rows[0].id;
    await pool.query(
      'INSERT INTO account_shares (account_id, user_id, level) VALUES ($1, $2, 2), ($3, $2, 2)',
      [walletA, otherUserId, exchange]
    );
    try {
      for (let i = 0; i < 3; i++) {
        await pool.query(
          `INSERT INTO transactions (user_id, category_id, debit_account_id, debit, credit, date, payee)
           VALUES ($1, $2, $3, 10, 10, '2026-01-01', 'bc1qcafe')`,
          [otherUserId, otherCategory, exchange]
        );
      }
      history.set('bc1qa', [tx('s2', 0, [['bc1qcafe', -500]])]);
      await syncAccount(otherUserId, walletA);
      const [expense] = (await rows(walletA)).filter(r => r.import_hash === 's2');
      const owner = await pool.query('SELECT user_id FROM categories WHERE id = $1', [expense.category_id]);
      expect(owner.rows[0].user_id).toBe(userId);
    } finally {
      await pool.query('DELETE FROM account_shares WHERE user_id = $1', [otherUserId]);
    }
  });

  it('refuses a user without write access', async () => {
    history.set('bc1qa', [tx('x1', 0, [['bc1qx', 5000]])]);
    await expect(syncAccount(otherUserId, walletA)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('refuses an untracked account', async () => {
    await expect(syncAccount(userId, exchange)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('refuses a deleted account', async () => {
    await pool.query('UPDATE accounts SET deleted = true WHERE id = $1', [walletB]);
    await expect(syncAccount(userId, walletB)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('writes nothing when the provider fails', async () => {
    spy.mockRejectedValueOnce({ statusCode: 502, message: 'Blockchain API unavailable' });
    await expect(syncAccount(userId, walletA)).rejects.toMatchObject({ statusCode: 502 });
    expect(await rows(walletA)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && npx jest --testPathPatterns=chainSync`
Expected: FAIL — `Cannot find module '../services/chainSync'`.

- [ ] **Step 3: Add the sync queries**

Append to `backend/src/db/queries/transactions.ts` (and change its first import line to `import { query, queryOne, execute, Tx } from '../index';`):

```ts
/**
 * Transaction ids already synced onto this account. A hash is the txid
 * itself or the txid with a ':fee' / ':out' suffix, so the suffix is cut.
 */
export const findSyncedTxids = async (accountId: number): Promise<string[]> => {
  const rows = await query<{ txid: string }>(
    `SELECT DISTINCT split_part(import_hash, ':', 1) AS txid
     FROM transactions
     WHERE import_hash IS NOT NULL
       AND (debit_account_id = $1 OR credit_account_id = $1)`,
    [accountId]
  );
  return rows.map(r => r.txid);
};

/** The row carrying `hash` on the given side of this account, locked for the sync. */
export const findByImportHashForUpdate = async (
  db: Tx,
  accountId: number,
  side: 'debit' | 'credit',
  hash: string
): Promise<Transaction | null> => {
  const column = side === 'debit' ? 'debit_account_id' : 'credit_account_id';
  return db.queryOne<Transaction>(
    `SELECT * FROM transactions WHERE ${column} = $1 AND import_hash = $2 FOR UPDATE`,
    [accountId, hash]
  );
};

export interface SyncedShape {
  debitAccountId: number | null;
  creditAccountId: number | null;
  debit: number;
  credit: number;
  categoryId: number | null;
}

/** Re-points an existing synced row; date, payee and description stay. */
export const setSyncedShape = async (db: Tx, id: number, shape: SyncedShape): Promise<void> => {
  await db.query(
    `UPDATE transactions
     SET debit_account_id = $1, credit_account_id = $2, debit = $3, credit = $4, category_id = $5
     WHERE id = $6`,
    [shape.debitAccountId, shape.creditAccountId, shape.debit, shape.credit, shape.categoryId, id]
  );
};

/**
 * One synced row. ON CONFLICT DO NOTHING against the import_hash indexes
 * makes a concurrent double sync harmless; returns whether it landed.
 */
export const insertSynced = async (
  db: Tx,
  userId: number,
  row: ImportedTransactionData
): Promise<boolean> => {
  const inserted = await db.query<{ id: number }>(
    `INSERT INTO transactions
       (user_id, category_id, debit_account_id, credit_account_id, debit, credit, date, description, payee, import_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT DO NOTHING
     RETURNING id`,
    [
      userId,
      row.categoryId ?? null,
      row.debitAccountId ?? null,
      row.creditAccountId ?? null,
      row.debit,
      row.credit,
      row.date,
      row.description || '',
      row.payee ?? null,
      row.importHash,
    ]
  );
  return inserted.length > 0;
};
```

- [ ] **Step 4: Write the sync service**

`backend/src/services/chainSync.ts`:

```ts
import { Tx, withTransaction } from '../db';
import * as accountQueries from '../db/queries/accounts';
import * as transactionQueries from '../db/queries/transactions';
import { Account } from '../types';
import { AccessLevel, LEVEL, getAccessMap } from './access';
import { ChainTx, getProvider, isTracked } from './chain';
import { suggestCategories } from './import/categorize';
import { getTreeCategoryIds, resolveCategoryForOwner } from './categories';

const UNCATEGORIZED_INCOME_CATEGORY_ID = 3;
const UNCATEGORIZED_EXPENSE_CATEGORY_ID = 4;
const NETWORK_FEES_CATEGORY_ID = 5;

export interface SyncResult {
  /** New income / expense / transfer rows. */
  added: number;
  /** Rows of another synced wallet turned into a transfer with this one. */
  merged: number;
  /** New Network fees rows. */
  fees: number;
}

/**
 * The ledger rows one on-chain transaction becomes for the synced account.
 * Receiving and paying are exclusive (see toChainTx), so a plan has either
 * `income`, or any of `transfer` / `expense` / a fee.
 */
export interface Plan {
  txid: string;
  date: string;
  fee: number;
  income?: { amount: number; from: string; peer: Account | undefined };
  /** Sent to another synced wallet of this user. */
  transfer?: { amount: number; peer: Account };
  /** Sent to anyone else, summed. */
  expense?: { amount: number; to: string };
}

const sum = (xs: { amount: number }[]) => xs.reduce((s, x) => s + x.amount, 0);

/**
 * Only the first synced peer paid in a transaction becomes a transfer; a
 * second synced peer in the same transaction is filed with the expense
 * (out of scope in the spec — practically never happens).
 */
export function planTx(tx: ChainTx, peers: ReadonlyMap<string, Account>): Plan {
  const plan: Plan = { txid: tx.txid, date: tx.date, fee: tx.fee };
  const incoming = tx.transfers.filter(t => t.amount > 0);
  if (incoming.length > 0) {
    const from = incoming[0].counterparty;
    plan.income = { amount: sum(incoming), from, peer: peers.get(from) };
    return plan;
  }

  const outgoing = tx.transfers.filter(t => t.amount < 0);
  const peerAddress = outgoing.find(t => peers.has(t.counterparty))?.counterparty;
  const toPeer = outgoing.filter(t => t.counterparty === peerAddress);
  const rest = outgoing.filter(t => t.counterparty !== peerAddress);
  if (peerAddress !== undefined) {
    plan.transfer = { amount: -sum(toPeer), peer: peers.get(peerAddress)! };
  }
  if (rest.length > 0) {
    plan.expense = { amount: -sum(rest), to: rest[0].counterparty };
  }
  return plan;
}

/** Other synced wallets on the same chain the user can write, by address. */
async function loadPeers(access: Map<number, AccessLevel>, account: Account): Promise<Map<string, Account>> {
  const writable = [...access]
    .filter(([id, level]) => id !== account.id && level >= LEVEL.WRITE)
    .map(([id]) => id);
  const accounts = await accountQueries.getAccountsByIds(writable);
  return new Map(
    accounts
      .filter(a => !a.deleted && isTracked(a) && a.settings.blockchain === account.settings.blockchain)
      .map(a => [a.settings.address as string, a])
  );
}

/**
 * Suggested category per txid for the income or expense row a plan files,
 * learned from history exactly like statement import, and resolved against
 * the account owner — the rows are stored in the owner's tree even when a
 * co-user runs the sync.
 */
async function suggest(userId: number, account: Account, access: Map<number, AccessLevel>, plans: Plan[]): Promise<Map<string, number>> {
  const filed = plans.filter(p => p.income || p.expense);
  if (filed.length === 0) return new Map();

  const history = await transactionQueries.findCategorizedHistory([...access.keys()]);
  const treeIds = await getTreeCategoryIds(userId);
  const suggestions = suggestCategories(
    filed.map(p => ({
      amount: p.income ? 1 : -1,
      payee: p.income ? p.income.from : p.expense!.to,
      description: '',
    })),
    history.flatMap(h => {
      const categoryId = treeIds.get(h.categoryId);
      return categoryId === undefined ? [] : [{ ...h, categoryId }];
    })
  );

  const result = new Map<string, number>();
  for (let i = 0; i < filed.length; i++) {
    const categoryId = suggestions[i].categoryId;
    if (categoryId !== null) {
      result.set(filed[i].txid, await resolveCategoryForOwner(categoryId, account.user_id));
    }
  }
  return result;
}

async function apply(
  db: Tx,
  userId: number,
  account: Account,
  plan: Plan,
  categories: Map<string, number>,
  result: SyncResult
): Promise<void> {
  const row = (fields: {
    debitAccountId?: number; creditAccountId?: number; amount: number;
    categoryId: number | null; payee: string | null; importHash: string;
  }) => transactionQueries.insertSynced(db, userId, {
    debitAccountId: fields.debitAccountId,
    creditAccountId: fields.creditAccountId,
    debit: fields.amount,
    credit: fields.amount,
    categoryId: fields.categoryId ?? undefined,
    date: plan.date,
    description: '',
    payee: fields.payee,
    importHash: fields.importHash,
  });

  if (plan.income) {
    const { amount, from, peer } = plan.income;
    // The sender is a synced wallet that already filed this tx as its own
    // expense (or a hand-set transfer): that row becomes the transfer, and
    // whatever else it paid stays behind as an expense — the same rows a
    // fresh sync of the sender would produce now.
    const sent = peer && await transactionQueries.findByImportHashForUpdate(db, peer.id, 'debit', plan.txid);
    if (sent && Number(sent.debit) >= amount) {
      await transactionQueries.setSyncedShape(db, sent.id, {
        debitAccountId: peer!.id, creditAccountId: account.id, debit: amount, credit: amount, categoryId: null,
      });
      const remainder = Number(sent.debit) - amount;
      if (remainder > 0) {
        await transactionQueries.insertSynced(db, sent.user_id, {
          debitAccountId: peer!.id,
          debit: remainder,
          credit: remainder,
          categoryId: sent.category_id ?? UNCATEGORIZED_EXPENSE_CATEGORY_ID,
          date: plan.date,
          description: '',
          payee: sent.payee,
          importHash: `${plan.txid}:out`,
        });
      }
      result.merged++;
    } else if (await row({
      creditAccountId: account.id, amount,
      categoryId: categories.get(plan.txid) ?? UNCATEGORIZED_INCOME_CATEGORY_ID,
      payee: from, importHash: plan.txid,
    })) {
      result.added++;
    }
  }

  if (plan.transfer) {
    const { amount, peer } = plan.transfer;
    // The receiver synced first and filed this tx as income (or the user
    // pointed it at another source): rule 3 — it is one transfer, ours.
    const received = await transactionQueries.findByImportHashForUpdate(db, peer.id, 'credit', plan.txid);
    if (received) {
      await transactionQueries.setSyncedShape(db, received.id, {
        debitAccountId: account.id, creditAccountId: peer.id, debit: amount, credit: amount, categoryId: null,
      });
      result.merged++;
    } else if (await row({
      debitAccountId: account.id, creditAccountId: peer.id, amount,
      categoryId: null, payee: peer.settings.address as string, importHash: plan.txid,
    })) {
      result.added++;
    }
  }

  if (plan.expense && await row({
    debitAccountId: account.id, amount: plan.expense.amount,
    categoryId: categories.get(plan.txid) ?? UNCATEGORIZED_EXPENSE_CATEGORY_ID,
    payee: plan.expense.to,
    // A transfer already holds the plain txid on this account.
    importHash: plan.transfer ? `${plan.txid}:out` : plan.txid,
  })) {
    result.added++;
  }

  if (plan.fee > 0 && await row({
    debitAccountId: account.id, amount: plan.fee,
    categoryId: NETWORK_FEES_CATEGORY_ID, payee: null, importHash: `${plan.txid}:fee`,
  })) {
    result.fees++;
  }
}

export const syncAccount = async (userId: number, accountId: number): Promise<SyncResult> => {
  const account = await accountQueries.getAccountById(accountId);
  // Same as import: a missing or deleted account is 403, not 404, so ids of
  // other users' accounts cannot be probed.
  if (!account || account.deleted) {
    throw { statusCode: 403, message: 'Cannot use this account' };
  }
  const access = await getAccessMap(userId);
  if ((access.get(accountId) ?? 0) < LEVEL.WRITE) {
    throw { statusCode: 403, message: 'Insufficient permissions for this account' };
  }
  if (!isTracked(account)) {
    throw { statusCode: 400, message: 'This account is not synced from a blockchain' };
  }

  // Everything from the network first: a failure part-way through paging
  // must leave the database untouched.
  const provider = getProvider(account.settings.blockchain)!;
  const known = new Set(await transactionQueries.findSyncedTxids(accountId));
  const txs = await provider.fetchNewTxs(account.settings.address as string, known);
  if (txs.length === 0) return { added: 0, merged: 0, fees: 0 };

  const peers = await loadPeers(access, account);
  const plans = txs.map(tx => planTx(tx, peers));
  const categories = await suggest(userId, account, access, plans);

  return withTransaction(async db => {
    const result: SyncResult = { added: 0, merged: 0, fees: 0 };
    for (const plan of plans) {
      await apply(db, userId, account, plan, categories, result);
    }
    return result;
  });
};
```

- [ ] **Step 5: Run the tests**

Run: `cd backend && npx jest --testPathPatterns=chainSync`
Expected: PASS. If "merges into the sender row…" fails on the `t4:out` payee, check `sent.payee` is carried (the sender's expense payee was `bc1qb`, its first external counterparty at the time).

- [ ] **Step 6: Commit**

```bash
git add backend/src/db/queries/transactions.ts backend/src/services/chainSync.ts backend/src/test/chainSync.test.ts
git commit -m "feat(sync): map chain transactions onto the ledger with transfer merging

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Sync endpoint

**Files:**
- Modify: `backend/src/routes/accounts.ts`
- Modify: `.env.example`
- Test: `backend/src/test/syncApi.test.ts`

**Interfaces:**
- Consumes: `syncAccount`, `SyncResult` (Task 5).
- Produces: `POST /api/accounts/:id/sync` → `{ data: { added, merged, fees }, error: null }`.

- [ ] **Step 1: Write the failing tests**

`backend/src/test/syncApi.test.ts` — end to end through the real Bitcoin provider, with `fetch` answering from the real fixture:

```ts
import request from 'supertest';
import * as fs from 'fs';
import * as path from 'path';
import { createTestApp } from './testApp';
import { pool } from '../db';

const app = createTestApp();
const SENDER = 'bc1qda5r9p5l9l74r2gzuz992nvda8d2lezr2wzk56';
const RECEIVER = 'bc1q3yxr3gkes4nmjvtmn5h5qasyh7jzusxzezys75';
const realTx = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'chain', 'tx-95333b08.json'), 'utf8')
);

describe('POST /api/accounts/:id/sync', () => {
  let token: string;
  let userId: number;
  let sender: number;
  let receiver: number;
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;

  const respond = (status: number, body: unknown) =>
    Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body } as Response);

  beforeAll(async () => {
    const email = `syncapi${Date.now()}@example.com`;
    const res = await request(app).post('/api/auth/register').send({ email, password: 'password123' });
    token = res.body.data.accessToken;
    userId = (await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id;
    const wallet = async (name: string, address: string) =>
      (await pool.query(
        `INSERT INTO accounts (user_id, name, currency, scale, start_balance, type, settings)
         VALUES ($1, $2, 'BTC', 8, 0, 'crypto', $3) RETURNING id`,
        [userId, name, JSON.stringify({ address, blockchain: 'bitcoin' })]
      )).rows[0].id as number;
    sender = await wallet('Sender', SENDER);
    receiver = await wallet('Receiver', RECEIVER);
  });

  beforeEach(() => {
    fetchMock = jest.fn((url: string) =>
      url.includes('/address/') ? respond(200, [realTx]) : respond(404, null)
    );
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterAll(async () => {
    global.fetch = originalFetch;
    await pool.query('DELETE FROM transactions WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM accounts WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM categories WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  });

  const sync = (id: number) =>
    request(app).post(`/api/accounts/${id}/sync`).set({ Authorization: `Bearer ${token}` });

  it('requires authentication', async () => {
    const res = await request(app).post(`/api/accounts/${sender}/sync`);
    expect(res.status).toBe(401);
  });

  it('syncs a real payment into transfer, expense and fee, then reports up to date', async () => {
    const first = await sync(sender);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ data: { added: 2, merged: 0, fees: 1 }, error: null });

    const rows = await pool.query(
      `SELECT debit_account_id, credit_account_id, debit::bigint::text AS debit, category_id, payee, import_hash
       FROM transactions WHERE debit_account_id = $1 ORDER BY import_hash`,
      [sender]
    );
    expect(rows.rows).toEqual([
      { debit_account_id: sender, credit_account_id: receiver, debit: '146435', category_id: null, payee: RECEIVER, import_hash: realTx.txid },
      { debit_account_id: sender, credit_account_id: null, debit: '9214', category_id: 5, payee: null, import_hash: `${realTx.txid}:fee` },
      { debit_account_id: sender, credit_account_id: null, debit: '238484212', category_id: 4, payee: 'bc1qy0rlysheyqwrjhs6e8ya82urst9d479wa24mrn', import_hash: `${realTx.txid}:out` },
    ]);

    const again = await sync(receiver);
    expect(again.body.data).toEqual({ added: 0, merged: 0, fees: 0 });
  });

  it('maps an unreachable API to 502', async () => {
    fetchMock.mockImplementation(() => Promise.reject(new Error('ECONNREFUSED')));
    const res = await sync(sender);
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('Blockchain API unavailable');
  });

  it('maps a rejected address to 400', async () => {
    fetchMock.mockImplementation(() => respond(400, 'Invalid Bitcoin address'));
    const res = await sync(sender);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid address');
  });
});
```

(Order matters: the 502/400 tests run after the successful sync, when both accounts already hold the txid; the provider is still called first, so the errors surface.)

- [ ] **Step 2: Run to verify they fail**

Run: `cd backend && npx jest --testPathPatterns=syncApi`
Expected: FAIL — 404 for the unknown route.

- [ ] **Step 3: Add the route**

In `backend/src/routes/accounts.ts`, add `import * as chainSync from '../services/chainSync';` and before `export default router;`:

```ts
router.post('/:id/sync', async (req: AuthRequest, res, next) => {
  try {
    const id = parseInt(req.params.id as string, 10);
    const result = await chainSync.syncAccount(req.userId!, id);
    res.json({ data: result, error: null });
  } catch (error) {
    next(error);
  }
});
```

- [ ] **Step 4: Document the env var**

Append to `.env.example`:
```
# Esplora API used to sync Bitcoin wallets (default https://mempool.space/api)
BITCOIN_ESPLORA_URL=https://mempool.space/api
```

- [ ] **Step 5: Run the whole backend suite**

Run: `cd backend && npm test`
Expected: all suites PASS. Also `npm run build` — no TypeScript errors.

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/accounts.ts backend/src/test/syncApi.test.ts .env.example
git commit -m "feat(sync): POST /api/accounts/:id/sync

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 7: Frontend — Sync button

**Files:**
- Modify: `frontend/src/app/models/account.ts`
- Modify: `frontend/src/app/core/api.service.ts`
- Modify: `frontend/src/app/core/accounts.state.ts`
- Create: `frontend/src/app/features/accounts/account-sync.service.ts`
- Test: `frontend/src/app/features/accounts/account-sync.service.spec.ts`
- Modify: `frontend/src/app/features/accounts/account-list/account-tree-node/account-tree-node.{ts,html}`

**Interfaces:**
- Consumes: `POST /api/accounts/:id/sync` (Task 6); `tracked` on account DTOs (Task 3).
- Produces:
  ```ts
  // models/account.ts
  AccountBase.tracked?: boolean
  export interface AccountSyncResult { added: number; merged: number; fees: number }
  export const SYNCED_CHAINS: Readonly<Record<string, string>> // { bitcoin: 'BTC' }
  // core/api.service.ts
  syncAccount(id: number): Observable<ApiResponse<AccountSyncResult>>
  // core/accounts.state.ts
  readonly trackedIds: Signal<ReadonlySet<number>>
  // features/accounts/account-sync.service.ts
  export function describeSync(r: AccountSyncResult): string
  export class AccountSyncService { readonly syncing: Signal<ReadonlySet<number>>; sync(account: Account): Promise<void> }
  ```

- [ ] **Step 1: Write the failing tests**

`frontend/src/app/features/accounts/account-sync.service.spec.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { Observable, of, throwError } from 'rxjs';
import { AccountSyncService, describeSync } from './account-sync.service';
import { ApiService } from '../../core/api.service';
import { AccountsState } from '../../core/accounts.state';
import { TransactionsState } from '../../core/transactions.state';
import { NotificationService } from '../../core/notification.service';
import type { Account } from '../../models/account';

describe('describeSync', () => {
  it('says so when nothing changed', () => {
    expect(describeSync({ added: 0, merged: 0, fees: 0 })).toBe('Already up to date');
  });

  it('lists only non-zero counts', () => {
    expect(describeSync({ added: 12, merged: 0, fees: 3 })).toBe('12 transactions added, 3 fees');
    expect(describeSync({ added: 1, merged: 1, fees: 1 })).toBe('1 transaction added, 1 merged into a transfer, 1 fee');
  });
});

describe('AccountSyncService', () => {
  const account = { id: 7, name: 'Cold' } as Account;
  let api: { syncAccount: ReturnType<typeof vi.fn> };
  let notifications: { showSuccess: ReturnType<typeof vi.fn>; showError: ReturnType<typeof vi.fn> };
  let accounts: { reload: ReturnType<typeof vi.fn> };
  let transactions: { reload: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    TestBed.resetTestingModule();
    api = { syncAccount: vi.fn() };
    notifications = { showSuccess: vi.fn(), showError: vi.fn() };
    accounts = { reload: vi.fn() };
    transactions = { reload: vi.fn() };
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: ApiService, useValue: api },
        { provide: NotificationService, useValue: notifications },
        { provide: AccountsState, useValue: accounts },
        { provide: TransactionsState, useValue: transactions },
      ],
    });
  });

  it('reloads lists and reports the result', async () => {
    api.syncAccount.mockReturnValue(of({ data: { added: 2, merged: 0, fees: 1 }, error: null }));
    const service = TestBed.inject(AccountSyncService);

    await service.sync(account);

    expect(api.syncAccount).toHaveBeenCalledWith(7);
    expect(accounts.reload).toHaveBeenCalled();
    expect(transactions.reload).toHaveBeenCalled();
    expect(notifications.showSuccess).toHaveBeenCalledWith('2 transactions added, 1 fee');
    expect(service.syncing().has(7)).toBe(false);
  });

  it('shows the backend error and clears the busy flag', async () => {
    api.syncAccount.mockReturnValue(throwError(() => new Error('Blockchain API unavailable')));
    const service = TestBed.inject(AccountSyncService);

    await service.sync(account);

    expect(notifications.showError).toHaveBeenCalled();
    expect(service.syncing().has(7)).toBe(false);
  });

  it('ignores a second press while the first sync runs', async () => {
    let finish!: () => void;
    api.syncAccount.mockReturnValue(new Observable(sub => {
      finish = () => { sub.next({ data: { added: 0, merged: 0, fees: 0 }, error: null }); sub.complete(); };
    }));
    const service = TestBed.inject(AccountSyncService);

    const first = service.sync(account);
    expect(service.syncing().has(7)).toBe(true);
    await service.sync(account);
    finish();
    await first;

    expect(api.syncAccount).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd frontend && npx ng test --watch=false --include=src/app/features/accounts/account-sync.service.spec.ts`
Expected: FAIL — module `./account-sync.service` not found.

- [ ] **Step 3: Model, API and state additions**

`frontend/src/app/models/account.ts` — in `AccountBase`, after `owner_name?: string;`:
```ts
  /** Transactions come from the blockchain; computed by the backend. */
  tracked?: boolean;
```
and at the end of the file:
```ts
export interface AccountSyncResult {
  added: number;
  merged: number;
  fees: number;
}

/**
 * Chains the backend syncs from, with their native currency. Mirrors the
 * provider registry in backend/src/services/chain/index.ts.
 */
export const SYNCED_CHAINS: Readonly<Record<string, string>> = { bitcoin: 'BTC' };
```

`frontend/src/app/core/api.service.ts` — import `AccountSyncResult` alongside `Account, AccountPayload`, and after `deleteAccount`:
```ts
  syncAccount(id: number): Observable<ApiResponse<AccountSyncResult>> {
    return this.http.post<ApiResponse<AccountSyncResult>>(`/api/accounts/${id}/sync`, {});
  }
```

`frontend/src/app/core/accounts.state.ts` — after `readonly visibleAccounts = …`:
```ts
  /** Accounts whose transactions come from the blockchain. */
  readonly trackedIds = computed<ReadonlySet<number>>(
    () => new Set(this.accounts().filter(a => a.tracked).map(a => a.id))
  );
```

- [ ] **Step 4: Write the service**

`frontend/src/app/features/accounts/account-sync.service.ts`:
```ts
import { inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { AccountsState } from '../../core/accounts.state';
import { TransactionsState } from '../../core/transactions.state';
import { NotificationService } from '../../core/notification.service';
import type { Account, AccountSyncResult } from '../../models/account';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function describeSync(r: AccountSyncResult): string {
  const parts: string[] = [];
  if (r.added) parts.push(`${plural(r.added, 'transaction', 'transactions')} added`);
  if (r.merged) parts.push(`${r.merged} merged into ${r.merged === 1 ? 'a transfer' : 'transfers'}`);
  if (r.fees) parts.push(plural(r.fees, 'fee', 'fees'));
  return parts.length > 0 ? parts.join(', ') : 'Already up to date';
}

/**
 * Runs a blockchain sync for one account. The busy set lives here rather
 * than in the tree node: reloading accounts re-renders the tree, and the
 * node would lose a local flag mid-sync.
 */
@Injectable({ providedIn: 'root' })
export class AccountSyncService {
  private readonly api = inject(ApiService);
  private readonly accounts = inject(AccountsState);
  private readonly transactions = inject(TransactionsState);
  private readonly notifications = inject(NotificationService);

  private readonly busy = signal<ReadonlySet<number>>(new Set());
  readonly syncing = this.busy.asReadonly();

  async sync(account: Account): Promise<void> {
    if (this.busy().has(account.id)) return;
    this.busy.update(s => new Set(s).add(account.id));
    try {
      const response = await firstValueFrom(this.api.syncAccount(account.id));
      // Sync reports only counts; balances move too, hence both lists.
      this.transactions.reload();
      this.accounts.reload();
      this.notifications.showSuccess(describeSync(response.data!));
    } catch (e) {
      this.notifications.showError(e, `Failed to sync ${account.name}`);
    } finally {
      this.busy.update(s => {
        const next = new Set(s);
        next.delete(account.id);
        return next;
      });
    }
  }
}
```

- [ ] **Step 5: Run the tests**

Run: `cd frontend && npx ng test --watch=false --include=src/app/features/accounts/account-sync.service.spec.ts`
Expected: PASS.

- [ ] **Step 6: Add the button to the tree node**

`account-tree-node.ts` — add `import { AccountSyncService } from '../../account-sync.service';`, the field
```ts
  protected readonly sync = inject(AccountSyncService);
```
and the handler after `onImport`:
```ts
  protected onSync(account: Account): void {
    void this.sync.sync(account);
  }
```

`account-tree-node.html` — directly after the closing `}` of the `@if (account.type === 'bank') { … }` block:
```html
      @if (account.tracked) {
      <button
        appearance="gray"
        class="small"
        [class.hidden]="!hovered && !sync.syncing().has(account.id)"
        [disabled]="sync.syncing().has(account.id)"
        iconStart="@tui.refresh-cw"
        size="xs"
        tuiIconButton
        (click)="onSync(account)"
        type="button">
        Sync
      </button>
      }
```

- [ ] **Step 7: Build and run the frontend suite**

Run: `cd frontend && npm test -- --watch=false && npm run build`
Expected: all specs PASS; build succeeds.

- [ ] **Step 8: Commit**

```bash
git add frontend/src/app/models/account.ts frontend/src/app/core/api.service.ts frontend/src/app/core/accounts.state.ts frontend/src/app/features/accounts/account-sync.service.ts frontend/src/app/features/accounts/account-sync.service.spec.ts frontend/src/app/features/accounts/account-list/account-tree-node
git commit -m "feat(sync): Sync button for blockchain accounts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 8: Frontend — account form for tracked wallets

**Files:**
- Modify: `frontend/src/app/features/accounts/account-form/account-form.{ts,html}`
- Test: `frontend/src/app/features/accounts/account-form/account-form.spec.ts`

**Interfaces:**
- Consumes: `SYNCED_CHAINS` (Task 7).
- Produces: `AccountForm.tracked: Signal<boolean>`; start balance and currency controls disabled (0 / chain currency) while tracked; `buildPayload()` still includes them (via `getRawValue`).

- [ ] **Step 1: Write the failing tests**

Append to `account-form.spec.ts` (inside the file, as a new `describe`):
```ts
describe('AccountForm tracked wallet', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('locks start balance and currency once address and chain are set', () => {
    const form = createForm({ currency: 'USD' });
    form.form.patchValue({ name: 'Cold', currency: 'USD', startBalance: 5, type: 'crypto', address: 'bc1qxy2k', blockchain: 'bitcoin' });

    expect(form.tracked()).toBe(true);
    expect(form.form.controls.startBalance.disabled).toBe(true);
    expect(form.form.controls.currency.disabled).toBe(true);
    expect(form.buildPayload()).toMatchObject({ startBalance: 0, currency: 'BTC' });
  });

  it('unlocks when the address is cleared', () => {
    const form = createForm({ currency: 'USD' });
    form.form.patchValue({ type: 'crypto', address: 'bc1qxy2k', blockchain: 'bitcoin' });
    form.form.patchValue({ address: '' });

    expect(form.tracked()).toBe(false);
    expect(form.form.controls.startBalance.enabled).toBe(true);
    expect(form.form.controls.currency.enabled).toBe(true);
  });

  it('does not lock for an unsupported chain', () => {
    const form = createForm({ currency: 'ETH' });
    form.form.patchValue({ type: 'crypto', address: '0xabc', blockchain: 'ethereum' });

    expect(form.tracked()).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify they fail**

Run: `cd frontend && npx ng test --watch=false --include=src/app/features/accounts/account-form/account-form.spec.ts`
Expected: FAIL — `form.tracked is not a function`.

- [ ] **Step 3: Implement**

`account-form.ts`:
- Update imports: `import { afterNextRender, ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';`, `import { toSignal, takeUntilDestroyed } from '@angular/core/rxjs-interop';`, `import { firstValueFrom, merge, startWith } from 'rxjs';` (replacing the existing `firstValueFrom` import), and `import { SYNCED_CHAINS, type Account, type AccountPayload, type AccountType } from '../../../models/account';` (replacing the existing type-only import).
- Add fields after `readonly type = toSignal(…)`:
```ts
  readonly blockchains: readonly string[] = ['', ...Object.keys(SYNCED_CHAINS)];
  readonly blockchainLabel = (chain: string): string => chain || 'None';
  /** Mirrors backend isTracked: transactions will come from the chain. */
  readonly tracked = signal(false);
```
- At the end of the constructor (after the settings controls are populated and after the `afterNextRender` workaround):
```ts
    // Applied synchronously with every change to the deciding controls, so a
    // patchValue and the lock can never disagree. A synced wallet's balance
    // comes only from the chain: it starts at 0 in the chain's own currency,
    // and the backend rejects anything else.
    const c = this.form.controls;
    merge(c.type.valueChanges, c.address.valueChanges, c.blockchain.valueChanges)
      .pipe(startWith(null), takeUntilDestroyed())
      .subscribe(() => this.applyTrackedLock());
```
- Add the method:
```ts
  private applyTrackedLock(): void {
    const { type, address, blockchain, startBalance, currency } = this.form.controls;
    const tracked = type.value === 'crypto' && address.value.trim() !== '' && blockchain.value in SYNCED_CHAINS;
    this.tracked.set(tracked);
    if (tracked) {
      startBalance.setValue(0);
      currency.setValue(SYNCED_CHAINS[blockchain.value]);
      startBalance.disable();
      currency.disable();
    } else {
      startBalance.enable();
      currency.enable();
    }
  }
```

`account-form.html` — replace the Blockchain textfield with a select:
```html
        <tui-textfield tuiChevron [tuiTextfieldCleaner]="false" [stringify]="blockchainLabel">
            <label tuiLabel>Blockchain</label>
            <input tuiSelect formControlName="blockchain" />
            <tui-data-list-wrapper *tuiDropdown [items]="blockchains" [itemContent]="blockchainLabel | tuiStringifyContent" />
        </tui-textfield>
```

- [ ] **Step 4: Run the tests**

Run: `cd frontend && npx ng test --watch=false --include=src/app/features/accounts/account-form/account-form.spec.ts`
Expected: PASS (new and existing specs, including "sends only crypto keys for a crypto account": its payload now has `startBalance: 0, currency: 'BTC'`, which the test already uses).

- [ ] **Step 5: Commit**

```bash
git add frontend/src/app/features/accounts/account-form
git commit -m "feat(accounts): chain select and locked balance for synced wallets

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 9: Frontend — transaction editing on synced accounts

**Files:**
- Create: `frontend/src/app/features/transactions/synced-lock.ts`
- Test: `frontend/src/app/features/transactions/synced-lock.spec.ts`
- Modify: `frontend/src/app/features/transactions/transaction-form/transaction-form.{ts,html,spec.ts}`
- Modify: `frontend/src/app/features/transactions/transaction-dialog.service.ts` (`openCreate`)
- Modify: `frontend/src/app/features/header/header.{ts,html}`

**Interfaces:**
- Consumes: `AccountsState.trackedIds` (Task 7).
- Produces:
  ```ts
  export interface SyncedLock { synced: boolean; debitLocked: boolean; creditLocked: boolean }
  export function syncedLock(t: Partial<Pick<Transaction, 'debit_account' | 'credit_account'>>, trackedIds: ReadonlySet<number>): SyncedLock
  // TransactionForm
  readonly lock: SyncedLock
  readonly accountOptions: Signal<Account[]>   // accounts minus tracked ones
  typeAllowed(index: 0 | 1 | 2): boolean       // 0 Expense, 1 Income, 2 Transfer
  ```

- [ ] **Step 1: Write the failing tests for the lock**

`frontend/src/app/features/transactions/synced-lock.spec.ts`:
```ts
import { describe, it, expect } from 'vitest';
import { syncedLock } from './synced-lock';

const acc = (id: number) => ({ id, name: `#${id}`, currency: 'BTC', scale: 8 });
const tracked = new Set([1, 2]);

describe('syncedLock', () => {
  it('locks nothing on an ordinary transaction', () => {
    expect(syncedLock({ debit_account: acc(3), credit_account: null }, tracked))
      .toEqual({ synced: false, debitLocked: false, creditLocked: false });
  });

  it('locks the synced side only', () => {
    expect(syncedLock({ debit_account: acc(1), credit_account: acc(3) }, tracked))
      .toEqual({ synced: true, debitLocked: true, creditLocked: false });
  });

  it('locks both sides of a transfer between synced wallets', () => {
    expect(syncedLock({ debit_account: acc(1), credit_account: acc(2) }, tracked))
      .toEqual({ synced: true, debitLocked: true, creditLocked: true });
  });
});
```

- [ ] **Step 2: Write the failing form tests**

In `transaction-form.spec.ts`, change `configure` to accept accounts and tracked ids (existing callers keep working):
```ts
function configure(data: Partial<Transaction>, accounts: Partial<Account>[] = [], trackedIds: number[] = []) {
  TestBed.configureTestingModule({
    providers: [
      TransactionForm,
      { provide: POLYMORPHEUS_CONTEXT, useValue: { data, completeWith: () => {} } },
      { provide: CategoriesState, useValue: { categories: signal(tree) } },
      { provide: AccountsState, useValue: { accounts: signal(accounts), trackedIds: signal(new Set(trackedIds)) } },
      { provide: TransactionsState, useValue: { transactions: signal([]) } },
      { provide: AuthService, useValue: { user: signal({ id: ME }) } },
      { provide: NotificationService, useValue: { showError: () => {} } },
    ],
  });
  return TestBed.inject(TransactionForm);
}
```
(add `import type { Account } from '../../../models/account';`), and append:
```ts
describe('TransactionForm on a synced account', () => {
  beforeEach(() => TestBed.resetTestingModule());

  const wallet = { id: 1, name: 'Cold', currency: 'BTC', scale: 8 };
  const exchange = { id: 3, name: 'Exchange', currency: 'BTC', scale: 8 };

  it('locks what the chain states and leaves the rest editable', () => {
    const form = configure(
      { id: 5, debit_account: wallet, debit: 0.001, credit: 0.001, date: '2026-05-29', payee: 'bc1qshop', category: myCategory },
      [wallet, exchange],
      [1]
    );
    const c = form.form.controls;

    expect(c.date.disabled).toBe(true);
    expect(c.payee.disabled).toBe(true);
    expect(c.fromAccount.disabled).toBe(true);
    expect(c.debitAmount.disabled).toBe(true);
    expect(c.category.enabled).toBe(true);
    expect(c.description.enabled).toBe(true);
    expect(c.toAccount.enabled).toBe(true);
    expect([form.typeAllowed(0), form.typeAllowed(1), form.typeAllowed(2)]).toEqual([true, false, true]);
  });

  it('offers only ordinary accounts to pick', () => {
    const form = configure({ debit_account: exchange }, [wallet, exchange], [1]);
    expect(form.accountOptions().map(a => a.id)).toEqual([3]);
  });

  it('allows no type change on a transfer between synced wallets', () => {
    const other = { id: 2, name: 'Hot', currency: 'BTC', scale: 8 };
    const form = configure({ id: 6, debit_account: wallet, credit_account: other }, [wallet, other], [1, 2]);
    expect([form.typeAllowed(0), form.typeAllowed(1), form.typeAllowed(2)]).toEqual([false, false, false]);
  });
});
```

- [ ] **Step 3: Run to verify they fail**

Run: `cd frontend && npx ng test --watch=false --include=src/app/features/transactions/synced-lock.spec.ts --include=src/app/features/transactions/transaction-form/transaction-form.spec.ts`
Expected: FAIL — `./synced-lock` missing; `typeAllowed` / `accountOptions` undefined.

- [ ] **Step 4: Write the lock helper**

`frontend/src/app/features/transactions/synced-lock.ts`:
```ts
import type { Transaction } from '../../models/transaction';

/**
 * Which sides of a transaction the blockchain owns. A locked side's account
 * and amount — and, on any synced transaction, the date and payee — are
 * fixed. Mirrors assertSyncedEdit in backend/src/services/transactions.ts;
 * the backend is the authority, this only shapes the form.
 */
export interface SyncedLock {
  synced: boolean;
  debitLocked: boolean;
  creditLocked: boolean;
}

export function syncedLock(
  t: Partial<Pick<Transaction, 'debit_account' | 'credit_account'>>,
  trackedIds: ReadonlySet<number>
): SyncedLock {
  const debitLocked = t.debit_account != null && trackedIds.has(t.debit_account.id);
  const creditLocked = t.credit_account != null && trackedIds.has(t.credit_account.id);
  return { synced: debitLocked || creditLocked, debitLocked, creditLocked };
}
```

- [ ] **Step 5: Apply it in the transaction form**

`transaction-form.ts`:
- `import { syncedLock } from '../synced-lock';`
- After `readonly accountMatcher = …` add:
```ts
  readonly lock = syncedLock(this.context.data, this.accountsState.trackedIds());
  /** Synced accounts are never picked by hand: sync alone writes to them. */
  readonly accountOptions = computed(() => {
    const tracked = this.accountsState.trackedIds();
    return this.accountsState.accounts().filter(a => !tracked.has(a.id));
  });
```
- Add a method:
```ts
  /** 0 Expense, 1 Income, 2 Transfer. A locked side must stay filled. */
  typeAllowed(index: 0 | 1 | 2): boolean {
    const { debitLocked, creditLocked } = this.lock;
    if (debitLocked && creditLocked) return false;
    if (debitLocked) return index !== 1;
    if (creditLocked) return index !== 0;
    return true;
  }
```
- At the start of the constructor (before `effect(...)`):
```ts
    const c = this.form.controls;
    if (this.lock.synced) {
      c.date.disable();
      c.payee.disable();
    }
    if (this.lock.debitLocked) {
      c.fromAccount.disable();
      c.debitAmount.disable();
    }
    if (this.lock.creditLocked) {
      c.toAccount.disable();
      c.creditAmount.disable();
    }
```
- In the effect's transfer branch, replace both `this.accountsState.accounts()` with `this.accountOptions()`, and filter the history guesses so a synced account is never proposed:
```ts
          const tracked = this.accountsState.trackedIds();
          if (!!fromAccount) {
            toAccount = this.transactionsState.transactions().filter(t => t.debit_account?.id === fromAccount!.id && !!t.credit_account && !tracked.has(t.credit_account.id))[0]?.credit_account ||
              this.accountOptions().filter(a => a.id !== fromAccount!.id && a.currency === fromAccount!.currency)[0] ||
              this.accountOptions().filter(a => a.id !== fromAccount!.id)[0];
            this.form.controls.toAccount.setValue(toAccount ?? null);
          } else if (!!toAccount) {
            fromAccount = this.transactionsState.transactions().filter(t => t.credit_account?.id === toAccount!.id && !!t.debit_account && !tracked.has(t.debit_account.id))[0]?.debit_account ||
              this.accountOptions().filter(a => a.id !== toAccount!.id && a.currency === toAccount!.currency)[0] ||
              this.accountOptions().filter(a => a.id !== toAccount!.id)[0];
            this.form.controls.fromAccount.setValue(fromAccount ?? null);
          }
```

`transaction-form.html`:
- Type buttons:
```html
        <button type="button" [disabled]="!typeAllowed(0)">Expense</button>
        <button type="button" [disabled]="!typeAllowed(1)">Income</button>
        <button type="button" [disabled]="accountsState.accounts().length < 2 || !typeAllowed(2)">Transfer</button>
```
- Both `<tui-data-list-wrapper *tuiDropdown [items]="accountsState.accounts()" …>` become `[items]="accountOptions()"`.

- [ ] **Step 6: Keep "Add transaction" off synced accounts**

In `transaction-dialog.service.ts`, `import { syncedLock } from './synced-lock';` and replace the first lines of `openCreate` up to `const defaultData = …` with:
```ts
    const { TransactionForm } = await import('./transaction-form/transaction-form');
    // Synced accounts take no hand-entered transactions, so neither the
    // prefill nor the default account may point at one.
    const tracked = this.accountState.trackedIds();
    const ordinary = this.accountState.accounts().filter(a => !tracked.has(a.id));
    const lastTransaction = this.transactionsState.transactions().find(t => !syncedLock(t, tracked).synced);
    if (!lastTransaction && ordinary.length < 1) {
      this.notifications.showError('No accounts available');
      return null;
    }
    const preferredAccount = ordinary.find(a => a.id === this.transactionsState.selectedAccountIds()[0]) || ordinary[0];
    const defaultData = buildCreateDefaults(lastTransaction, preferredAccount, new Date().toISOString().split('T')[0])!;
```

- [ ] **Step 7: Hide Delete for synced transactions**

`header.ts` — `import { computed } from '@angular/core';` (merge into the existing import) and `import { syncedLock } from '../transactions/synced-lock';`, then after `readonly selectedTransaction = …`:
```ts
  readonly canDelete = computed(() => {
    const t = this.selectedTransaction();
    return !!t && !syncedLock(t, this.accountState.trackedIds()).synced;
  });
```
`header.html` — wrap the delete button:
```html
@if (canDelete()) {
<button tuiIconButton tuiTheme="dark" appearance="flat-grayscale" size="xs" (click)="deleteTransaction()" [iconStart]="'@tui.trash-2'" aria-label="Delete transaction"></button>
}
```

- [ ] **Step 8: Run the frontend suite and build**

Run: `cd frontend && npm test -- --watch=false && npm run build`
Expected: all specs PASS; build succeeds.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/app/features/transactions frontend/src/app/features/header
git commit -m "feat(transactions): lock chain-stated fields in the form

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 10: Docs and live check

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1: Update CLAUDE.md**

In the "Database" list, change `run in order (001→004)` to `run in order (001→012)`, and after the `account_shares` bullet add:
```markdown
- System category **Network fees** (id 5, under Expenses) seeded in
  migration 012; ids 1–5 are protected from edit/delete.

#### Blockchain-synced (tracked) accounts

A `crypto` account with `settings.address` and a supported
`settings.blockchain` (today `bitcoin`, see `services/chain/index.ts`) is
*tracked*: `POST /api/accounts/:id/sync` loads its history through a chain
provider (`services/chain/bitcoin.ts`, Esplora at `BITCOIN_ESPLORA_URL`) and
`services/chainSync.ts` writes it, identified by `import_hash` (`txid`,
`txid:out`, `txid:fee`). Tracked accounts start at 0 in the chain's currency;
their transactions cannot be created, deleted or imported by hand, and an
edit may change only the category, the other (untracked) account and its
amount when currencies differ, and the description. A payment between two
tracked wallets is one transfer, merged whichever side syncs first.
```

- [ ] **Step 2: Live check against the real API**

With the dev DB migrated (Task 1) and the backend running (`cd backend && npm run dev`), in another shell:
```bash
EMAIL="synccheck$(date +%s)@example.com"
TOKEN=$(curl -s localhost:3000/api/auth/register -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"password123\"}" | python3 -c 'import json,sys;print(json.load(sys.stdin)["data"]["accessToken"])')
ID=$(curl -s localhost:3000/api/accounts -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"name":"Sync check","currency":"BTC","startBalance":0,"type":"crypto","settings":{"address":"bc1q3yxr3gkes4nmjvtmn5h5qasyh7jzusxzezys75","blockchain":"bitcoin"}}' \
  | python3 -c 'import json,sys;print(json.load(sys.stdin)["data"]["id"])')
curl -s -X POST localhost:3000/api/accounts/$ID/sync -H "Authorization: Bearer $TOKEN"; echo
curl -s localhost:3000/api/accounts -H "Authorization: Bearer $TOKEN" | python3 -c 'import json,sys;print([a["balance"] for a in json.load(sys.stdin)["data"]])'
curl -s -X POST localhost:3000/api/accounts/$ID/sync -H "Authorization: Bearer $TOKEN"; echo
```
Expected: first sync `{"data":{"added":136,"merged":0,"fees":0},"error":null}` (or more, if the address received new payments since 2026-09-24 — then compare with `curl -s https://mempool.space/api/address/bc1q3yxr3gkes4nmjvtmn5h5qasyh7jzusxzezys75` `chain_stats.tx_count`); balance `[0.08220906]` (or `chain_stats.funded_txo_sum / 1e8`); second sync `{"added":0,"merged":0,"fees":0}`.

Then remove the throwaway user:
```bash
psql "$(grep '^DATABASE_URL=' backend/.env | cut -d= -f2-)" -c "
  DELETE FROM transactions WHERE user_id = (SELECT id FROM users WHERE email = '$EMAIL');
  DELETE FROM accounts WHERE user_id = (SELECT id FROM users WHERE email = '$EMAIL');
  DELETE FROM categories WHERE user_id = (SELECT id FROM users WHERE email = '$EMAIL');
  DELETE FROM users WHERE email = '$EMAIL';"
```

- [ ] **Step 3: UI check**

`cd frontend && npm start`, log in, create a Crypto account with the test address and chain Bitcoin (start balance and currency lock to 0 / BTC), hover it in the tree, press **Sync**: a success notification "136 transactions added" appears and the balance shows 0.08220906 BTC. Open one of its transactions: date, payee, account and amount are disabled; category and description editable; the Delete button is absent from the header. Delete the test account's data afterwards as in Step 2 if it was created under a real user.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: blockchain-synced accounts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
