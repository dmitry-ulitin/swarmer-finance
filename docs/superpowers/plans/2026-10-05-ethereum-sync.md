# Ethereum Sync (ETH, USDT-ERC20) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `crypto` account with `settings.blockchain = 'ethereum'` syncs its history in its own currency — native ETH (with internal incoming transfers and gas) or USDT (ERC20).

**Architecture:** A new `services/chain/ethereum.ts` speaks the Etherscan-compatible account API (Etherscan v2 when `ETHERSCAN_API_KEY` is set, Blockscout otherwise) and maps its lists to the existing chain-agnostic `ChainTx`. `ChainProvider` gains an optional `normalizeAddress` so Ethereum addresses are stored lowercase; adopt's txid regex learns the `0x` prefix. `chainSync` is unchanged. The frontend only adds `ethereum` to `SYNCED_CHAINS`.

**Tech Stack:** Node.js + Express + raw SQL (PostgreSQL), Jest + supertest; Angular 22 + Taiga UI v5, Vitest via `ng test`.

**Spec:** `docs/superpowers/specs/2026-10-05-ethereum-sync-design.md` (builds on the blockchain-sync, adopt and TRON specs of 2026-09-24/25).

## Global Constraints

- Endpoint: with env `ETHERSCAN_API_KEY` → `https://api.etherscan.io/v2/api?chainid=1&apikey=<key>&<query>`; without → `${ETHEREUM_API_URL || 'https://eth.blockscout.com/api'}?<query>`.
- Request spacing: ≥ 250 ms with a key, ≥ 1100 ms without, across pages and syncs in one process.
- `ethereum` currencies: `{ ETH: 8, USDT: 6 }`; USDT contract `0xdac17f958d2ee523a2206206994597c13d831ec7`.
- Query: `module=account&address=<lowercase addr>&action=<txlist|txlistinternal|tokentx>[&contractaddress=<USDT>]&sort=desc&page=<n>&offset=1000`.
- Errors: timeout 10 s; network error, timeout, non-2xx, non-JSON body, or `status !== '1'` → `{ statusCode: 502, message: 'Blockchain API unavailable' }`, except `status '0'` + message `No transactions found` → empty list. Address not matching `/^0x[0-9a-fA-F]{40}$/` → `{ statusCode: 400, message: 'Invalid address' }` with no request.
- Wei → scale 8: `Number((wei + 5_000_000_000n) / 10_000_000_000n)` (half-up); a value or fee that becomes 0 is dropped.
- Fees only on the ETH account, for every normal transaction whose `from` is the address (failed ones and USDT sends included). USDT `ChainTx.fee` is always 0.
- Ethereum addresses stored lowercase; base58 addresses (bitcoin, tron) untouched.
- Error message for a wrong currency: `A blockchain-synced account must be in ETH or USDT` (comes from existing `assertTrackedShape`).
- No migration. Backend tests: `cd backend && npx jest --testPathPatterns=<name>`. Frontend tests: `cd frontend && npx ng test --watch=false --include=<spec path>` — never bare `npx vitest`.
- Commit messages end with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **A transaction that yields no transfers and no fee must still come back** (the 1e-9 ETH internal transfer that rounds to 0, a record of another token): otherwise it is never marked seen and every sync re-reads history. Pinned in Task 1 (`returns the dust internal transfer as an empty ChainTx`, `returns an other-token tx with no transfers`).
2. **Fee attribution**: an incoming transfer's gas is paid by its sender and must not become a fee row here. Pinned in Task 1 (`reads an incoming ETH transfer without a fee`).
3. **Blockscout `status: '2'`** (internal transactions not yet indexed) must fail the sync, not read as "nothing there". Pinned in Task 2.
4. **Mixed-case address on save** must merge with lowercase counterparties from the API; otherwise transfers between two of the user's wallets become an expense + an income. Pinned in Task 3 (merge test).
5. **Existing Bitcoin/TRON behaviour and txid matching** must not change (address case kept, bare 64-hex txids still adopt). Pinned in Task 3 (`keeps the case of a TRON address`) and Task 4 (the existing `matchRows` suite).

---

## File Structure

| File | Change | Responsibility |
|------|--------|----------------|
| `backend/src/services/chain/ethereum.ts` | create | Etherscan-API client, wei rounding, list → `ChainTx` mapping |
| `backend/src/services/chain/types.ts` | modify | optional `ChainProvider.normalizeAddress` |
| `backend/src/services/chain/index.ts` | modify | register `ethereum` |
| `backend/src/services/accounts.ts` | modify | store the normalised address on create/update |
| `backend/src/services/chainAdopt.ts` | modify | `TXID` with optional `0x`, prefix-insensitive compare |
| `backend/src/test/ethereumProvider.test.ts` | create | provider unit tests on fixtures |
| `backend/src/test/trackedAccounts.test.ts` | modify | address normalisation + merge between two ETH wallets |
| `backend/src/test/chainAdopt.test.ts` | modify | `0x` txid matching |
| `backend/src/test/fixtures/chain/eth-txlist-0xf4f8.json`, `eth-internal-0xf4f8.json`, `eth-usdt-0xf4f8.json` | **already committed** | Etherscan responses (`sort=desc`) for `0xf4f8d6fb5117cec024d135d91c012636b814cc07`, recorded 2026-10-05: 32 normal, 1 internal, 20 USDT |
| `.env.example` | modify | `ETHEREUM_API_URL`, `ETHERSCAN_API_KEY` |
| `frontend/src/app/models/account.ts` | modify | `SYNCED_CHAINS.ethereum` |
| `frontend/src/app/features/accounts/account-form/account-form.spec.ts` | modify | ethereum offers ETH/USDT |
| `CLAUDE.md` | modify | mention ethereum |

Facts from the fixtures used below (computed from the recorded files):

- ETH lists → 33 `ChainTx`: 15 with an incoming transfer, 7 with an outgoing one, 15 with a fee; they net to `21651` (1e-8 ETH).
- `0xd678ac4de640acc495d429554dd78e7430ab5007dd0c2de62d3abe19c3a2badd` (2026-03-08): fee 72, `−3620073` to `0x253dd57300904225762960755b7662e6ae06492d`.
- `0x060a6296313782d38e157c1142f004d0e43523957717376ec710a8b4d86dd63f` (2026-10-05): `+7510` from `0x20ffdcfc8b16685f3109a3b56da3847b3caa2533` (75098621795400 wei), fee 0.
- `0xa083c81616953d32c90f24099b60882e7453d9ea347e63edc217eb22229557a6` (2026-10-05): a USDT send — fee 3766, no ETH transfers. Newest normal tx.
- `0xaf8f4c939d3f158c2d0eaa57366325cd64e998fa4ca3cc6e5a7aa7794d122238` (2026-03-21): the only internal record, 1000000000 wei from `0x2530ae7f4044d2ff91ed2a082ee1e712bad7492d` → rounds to 0.
- Oldest normal tx: `0x4951bf7ec9067d527a5cf2ed0c92301fcdd5ef31faedc69e184245fe859cb735`.
- USDT list → 20 `ChainTx`, one record each, net `50`; `0x2b8b50431ea4627e07e7e4156158fdeb64d7cbf96b86b44933dc53a65cdaf706` (2026-10-05) `+1000000000` from `0x8108f44df5f755d36f395b69b8749165c3933a67`; `0xa083c816…` `−1000000000` to `0x253dd573…`. Oldest: `0x5e5a9762fc8948821a6d3fcd505bfbb316798486e5f983e69399afed33ff472a`.

---

### Task 1: Ethereum list → ChainTx mapping

Pure functions, no network.

**Files:**
- Create: `backend/src/services/chain/ethereum.ts`
- Create: `backend/src/test/ethereumProvider.test.ts`

**Interfaces:**
- Produces (exported from `ethereum.ts`): `USDT_CONTRACT: string`; `interface EthTx`, `interface TokenTransfer`; `weiToScale8(wei: bigint): number`; `tokenToChainTxs(records: TokenTransfer[], address: string): ChainTx[]`; `ethToChainTxs(normal: EthTx[], internal: EthTx[], address: string): ChainTx[]`. `address` is lowercase; records are oldest first.

- [ ] **Step 1: Write the failing tests**

`backend/src/test/ethereumProvider.test.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';
import {
  ethToChainTxs, tokenToChainTxs, weiToScale8, EthTx, TokenTransfer, USDT_CONTRACT,
} from '../services/chain/ethereum';

const ADDR = '0xf4f8d6fb5117cec024d135d91c012636b814cc07';
const fixture = <T>(name: string): { status: string; message: string; result: T[] } =>
  JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'chain', name), 'utf8'));
// Recorded newest first (sort=desc); the mapping functions take oldest first.
const normal = fixture<EthTx>('eth-txlist-0xf4f8.json').result.slice().reverse();
const internal = fixture<EthTx>('eth-internal-0xf4f8.json').result.slice().reverse();
const usdt = fixture<TokenTransfer>('eth-usdt-0xf4f8.json').result.slice().reverse();

const ROUTER = '0x7a250d5630b4cf539739df2c5dacb4c659f2488d';
const ethTx = (over: Partial<EthTx>): EthTx => ({
  hash: '0xsynthetic', blockNumber: '26000000', timeStamp: '1789700000',
  from: ADDR, to: ROUTER, value: '0', isError: '0', gasUsed: '100000', gasPrice: '1000000000', ...over,
});

describe('weiToScale8', () => {
  it.each([
    [15000000000n, 2],
    [14999999999n, 1],
    [4999999999n, 0],
    [1000000000000000000n, 100000000],
  ])('rounds %s wei half-up to %i', (wei, units) => {
    expect(weiToScale8(wei)).toBe(units);
  });
});

describe('tokenToChainTxs', () => {
  const txs = tokenToChainTxs(usdt, ADDR);
  const byId = (prefix: string) => txs.find(t => t.txid.startsWith(prefix))!;

  it('returns one ChainTx per transaction, oldest first', () => {
    expect(txs).toHaveLength(20);
    expect(txs[0].txid).toBe('0x5e5a9762fc8948821a6d3fcd505bfbb316798486e5f983e69399afed33ff472a');
  });

  it('reads a USDT receipt', () => {
    expect(byId('0x2b8b5043')).toEqual({
      txid: '0x2b8b50431ea4627e07e7e4156158fdeb64d7cbf96b86b44933dc53a65cdaf706',
      date: '2026-10-05',
      fee: 0,
      transfers: [{ counterparty: '0x8108f44df5f755d36f395b69b8749165c3933a67', amount: 1000000000 }],
    });
  });

  it('reads a USDT payment without a fee', () => {
    expect(byId('0xa083c816')).toMatchObject({
      fee: 0,
      transfers: [{ counterparty: '0x253dd57300904225762960755b7662e6ae06492d', amount: -1000000000 }],
    });
  });

  it('nets to the USDT balance on the chain', () => {
    expect(txs.flatMap(t => t.transfers).reduce((s, t) => s + t.amount, 0)).toBe(50);
  });

  const rec = (over: Partial<TokenTransfer>): TokenTransfer => ({
    hash: '0xmulti', blockNumber: '26000000', timeStamp: '1789700000',
    from: ADDR, to: '0x1', value: '5', contractAddress: USDT_CONTRACT, ...over,
  });

  it('returns an other-token tx with no transfers', () => {
    expect(tokenToChainTxs([rec({ contractAddress: '0xfa4e' })], ADDR)).toEqual([
      { txid: '0xmulti', date: '2026-09-18', fee: 0, transfers: [] },
    ]);
  });

  it('groups several transfers of one transaction and drops a transfer to itself', () => {
    expect(tokenToChainTxs([rec({ to: '0x1' }), rec({ to: '0x2', value: '7' }), rec({ to: ADDR, value: '9' })], ADDR))
      .toEqual([{
        txid: '0xmulti', date: '2026-09-18', fee: 0,
        transfers: [{ counterparty: '0x1', amount: -5 }, { counterparty: '0x2', amount: -7 }],
      }]);
  });
});

describe('ethToChainTxs', () => {
  const txs = ethToChainTxs(normal, internal, ADDR);
  const byId = (prefix: string) => txs.find(t => t.txid.startsWith(prefix))!;

  it('returns one ChainTx per hash across both lists, oldest first', () => {
    expect(txs).toHaveLength(33);
    expect(txs[0].txid).toBe('0x4951bf7ec9067d527a5cf2ed0c92301fcdd5ef31faedc69e184245fe859cb735');
    expect(txs[32].txid).toBe('0xa083c81616953d32c90f24099b60882e7453d9ea347e63edc217eb22229557a6');
    expect(txs.filter(t => t.transfers.some(x => x.amount > 0))).toHaveLength(15);
    expect(txs.filter(t => t.transfers.some(x => x.amount < 0))).toHaveLength(7);
    expect(txs.filter(t => t.fee > 0)).toHaveLength(15);
  });

  it('reads an outgoing ETH transfer with its fee', () => {
    expect(byId('0xd678ac4d')).toEqual({
      txid: '0xd678ac4de640acc495d429554dd78e7430ab5007dd0c2de62d3abe19c3a2badd',
      date: '2026-03-08',
      fee: 72,
      transfers: [{ counterparty: '0x253dd57300904225762960755b7662e6ae06492d', amount: -3620073 }],
    });
  });

  it('reads an incoming ETH transfer without a fee', () => {
    expect(byId('0x060a6296')).toMatchObject({
      fee: 0,
      transfers: [{ counterparty: '0x20ffdcfc8b16685f3109a3b56da3847b3caa2533', amount: 7510 }],
    });
  });

  it('reads a USDT send as a fee-only transaction', () => {
    expect(byId('0xa083c816')).toMatchObject({ fee: 3766, transfers: [] });
  });

  it('returns the dust internal transfer as an empty ChainTx', () => {
    expect(byId('0xaf8f4c93')).toEqual({
      txid: '0xaf8f4c939d3f158c2d0eaa57366325cd64e998fa4ca3cc6e5a7aa7794d122238',
      date: '2026-03-21', fee: 0, transfers: [],
    });
  });

  it('nets to the chain balance within rounding', () => {
    const total = txs.reduce((s, t) => s - t.fee + t.transfers.reduce((a, x) => a + x.amount, 0), 0);
    expect(total).toBe(21651);
  });

  it('keeps only the fee of a failed transaction', () => {
    expect(ethToChainTxs([ethTx({ value: '1000000000000000000', isError: '1', gasUsed: '21000' })], [], ADDR))
      .toEqual([{ txid: '0xsynthetic', date: '2026-09-18', fee: 2100, transfers: [] }]);
  });

  it('merges a swap payout from the internal list into our transaction', () => {
    const payout = ethTx({ from: ROUTER, to: ADDR, value: '500000000000000000', gasUsed: undefined, gasPrice: undefined });
    expect(ethToChainTxs([ethTx({})], [payout], ADDR)).toEqual([
      { txid: '0xsynthetic', date: '2026-09-18', fee: 10000, transfers: [{ counterparty: ROUTER, amount: 50000000 }] },
    ]);
  });

  it('nets a refund against what was sent', () => {
    const refund = ethTx({ from: ROUTER, to: ADDR, value: '100000000000000000', gasUsed: undefined, gasPrice: undefined });
    expect(ethToChainTxs([ethTx({ value: '1000000000000000000' })], [refund], ADDR)[0].transfers)
      .toEqual([{ counterparty: ROUTER, amount: -90000000 }]);
  });

  it('drops a refund that cancels what was sent', () => {
    const refund = ethTx({ from: ROUTER, to: ADDR, value: '1000000000000000000', gasUsed: undefined, gasPrice: undefined });
    expect(ethToChainTxs([ethTx({ value: '1000000000000000000' })], [refund], ADDR)[0].transfers).toEqual([]);
  });

  it('ignores a failed internal transfer and a transfer to itself', () => {
    const failed = ethTx({ hash: '0xi', from: ROUTER, to: ADDR, value: '1000000000000000000', isError: '1' });
    const self = ethTx({ hash: '0xs', to: ADDR, value: '1000000000000000000', gasUsed: '21000' });
    expect(ethToChainTxs([self], [failed], ADDR)).toEqual([
      { txid: '0xs', date: '2026-09-18', fee: 2100, transfers: [] },
      { txid: '0xi', date: '2026-09-18', fee: 0, transfers: [] },
    ]);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npx jest --testPathPatterns=ethereumProvider`
Expected: FAIL — `Cannot find module '../services/chain/ethereum'`.

- [ ] **Step 3: Implement the mapping**

`backend/src/services/chain/ethereum.ts`:

```ts
import { ChainTransfer, ChainTx } from './types';

/** Tether's USDT on Ethereum; transfers of any other token are ignored. */
export const USDT_CONTRACT = '0xdac17f958d2ee523a2206206994597c13d831ec7';

/** The parts of an Etherscan-API normal or internal transaction this provider reads. */
export interface EthTx {
  hash: string;
  blockNumber: string;
  /** Unix seconds as a decimal string. */
  timeStamp: string;
  from: string;
  /** Empty for a contract creation. */
  to: string;
  /** Wei as a decimal string. */
  value: string;
  isError: string;
  /** Normal transactions only; `gasPrice` there is the effective price paid. */
  gasUsed?: string;
  gasPrice?: string;
}

/** The parts of an Etherscan-API token transfer this provider reads. */
export interface TokenTransfer {
  hash: string;
  blockNumber: string;
  timeStamp: string;
  from: string;
  to: string;
  /** Token base units as a decimal string. */
  value: string;
  contractAddress: string;
}

const toDate = (seconds: string) => new Date(Number(seconds) * 1000).toISOString().slice(0, 10);

/**
 * Wei in the 1e-8 ETH units ETH accounts store (currencyScale.ts caps ETH
 * at 8 decimals), rounded half-up. Sub-unit amounts become 0.
 */
export const weiToScale8 = (wei: bigint): number => Number((wei + 5_000_000_000n) / 10_000_000_000n);

/**
 * USDT movements grouped by transaction. A transaction whose records are all
 * dropped (another token, a transfer to itself) still comes back, with no
 * transfers, so sync marks it seen and paging can stop on it. Values are read
 * as Numbers: one transfer would need 9e9 USDT to lose precision.
 */
export function tokenToChainTxs(records: TokenTransfer[], address: string): ChainTx[] {
  const byTx = new Map<string, ChainTx>();
  for (const r of records) {
    let tx = byTx.get(r.hash);
    if (!tx) {
      tx = { txid: r.hash, date: toDate(r.timeStamp), fee: 0, transfers: [] };
      byTx.set(r.hash, tx);
    }
    if (r.contractAddress !== USDT_CONTRACT || r.from === r.to) continue;
    const value = Number(r.value);
    if (r.to === address) tx.transfers.push({ counterparty: r.from, amount: value });
    else if (r.from === address) tx.transfers.push({ counterparty: r.to, amount: -value });
  }
  return [...byTx.values()];
}

/**
 * One movement for a transaction that both sent and received ETH (a DEX
 * refunding the excess): planTx files a transaction with anything incoming
 * as income only, which would lose what was sent.
 */
function net(transfers: ChainTransfer[]): ChainTransfer[] {
  if (!transfers.some(t => t.amount > 0) || !transfers.some(t => t.amount < 0)) return transfers;
  const amount = transfers.reduce((s, t) => s + t.amount, 0);
  if (amount === 0) return [];
  const largest = transfers
    .filter(t => Math.sign(t.amount) === Math.sign(amount))
    .reduce((a, b) => (Math.abs(b.amount) > Math.abs(a.amount) ? b : a));
  return [{ counterparty: largest.counterparty, amount }];
}

/**
 * ETH movements of both lists, merged by hash, oldest first. Gas is ours
 * whenever we sent the transaction — whatever it did, USDT sends and failed
 * calls included; the sender of an incoming transfer pays its own. Internal
 * transfers count only incoming (an ordinary wallet cannot make one).
 */
export function ethToChainTxs(normal: EthTx[], internal: EthTx[], address: string): ChainTx[] {
  const byTx = new Map<string, ChainTx & { block: number }>();
  const txOf = (r: EthTx) => {
    let tx = byTx.get(r.hash);
    if (!tx) {
      tx = { txid: r.hash, block: Number(r.blockNumber), date: toDate(r.timeStamp), fee: 0, transfers: [] };
      byTx.set(r.hash, tx);
    }
    return tx;
  };
  const move = (tx: ChainTx, counterparty: string, wei: bigint, sign: 1 | -1) => {
    const amount = weiToScale8(wei);
    if (amount > 0) tx.transfers.push({ counterparty, amount: sign * amount });
  };

  for (const r of normal) {
    const tx = txOf(r);
    const value = BigInt(r.value);
    if (r.isError === '0' && value > 0n) {
      if (r.to === address && r.from !== address) move(tx, r.from, value, 1);
      else if (r.from === address && r.to !== address && r.to !== '') move(tx, r.to, value, -1);
    }
    if (r.from === address) tx.fee = weiToScale8(BigInt(r.gasUsed ?? '0') * BigInt(r.gasPrice ?? '0'));
  }
  for (const r of internal) {
    const tx = txOf(r);
    if (r.isError === '0' && r.to === address && r.from !== address) move(tx, r.from, BigInt(r.value), 1);
  }

  return [...byTx.values()]
    .sort((a, b) => a.block - b.block)
    .map(({ txid, date, fee, transfers }) => ({ txid, date, fee, transfers: net(transfers) }));
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && npx jest --testPathPatterns=ethereumProvider`
Expected: PASS. If `nets to the chain balance` or a count differs, recheck against the "Facts from the fixtures" list — do not edit the expectation to fit.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/chain/ethereum.ts backend/src/test/ethereumProvider.test.ts
git commit -m "feat(chain): map Etherscan-API ETH and USDT lists to ChainTx

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 2: Ethereum provider — fetching, paging, errors, registration

**Files:**
- Modify: `backend/src/services/chain/ethereum.ts`
- Modify: `backend/src/services/chain/types.ts`
- Modify: `backend/src/services/chain/index.ts`
- Modify: `.env.example`
- Test: `backend/src/test/ethereumProvider.test.ts`

**Interfaces:**
- Consumes: Task 1's `tokenToChainTxs`, `ethToChainTxs`, `EthTx`, `TokenTransfer`, `USDT_CONTRACT`.
- Produces: `ChainProvider.normalizeAddress?(address: string): string` (in `types.ts`); `ethereumProvider: ChainProvider` with `currencies { ETH: 8, USDT: 6 }` and `normalizeAddress = a => a.toLowerCase()`; `getProvider('ethereum')` returns it.

- [ ] **Step 1: Write the failing tests**

Append to `backend/src/test/ethereumProvider.test.ts` (and add `ethereumProvider` and `getProvider` to the imports: `import { ethereumProvider, … } from '../services/chain/ethereum';` and `import { getProvider } from '../services/chain';`):

```ts
describe('ethereumProvider.fetchNewTxs', () => {
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;
  const raw = (name: string) => fixture<unknown>(name);
  const ok = (body: unknown) => Promise.resolve({ ok: true, status: 200, json: async () => body } as Response);
  const empty = { status: '0', message: 'No transactions found', result: [] };
  const KEYED = 'https://api.etherscan.io/v2/api?chainid=1&apikey=test-key&module=account';

  beforeEach(() => {
    fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    process.env.ETHERSCAN_API_KEY = 'test-key';
    delete process.env.ETHEREUM_API_URL;
  });
  afterEach(() => {
    delete process.env.ETHERSCAN_API_KEY;
  });
  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('is registered for ethereum, syncs ETH and USDT, and stores addresses lowercase', () => {
    expect(getProvider('ethereum')).toBe(ethereumProvider);
    expect(ethereumProvider.currencies).toEqual({ ETH: 8, USDT: 6 });
    expect(ethereumProvider.normalizeAddress!('0xF4f8d6fB5117CEc024d135d91C012636b814CC07')).toBe(ADDR);
  });

  it('reads the USDT list of the official contract from Etherscan with the key', async () => {
    fetchMock.mockImplementation(() => ok(raw('eth-usdt-0xf4f8.json')));
    const txs = await ethereumProvider.fetchNewTxs(ADDR, 'USDT', new Set());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe(
      `${KEYED}&address=${ADDR}&action=tokentx&contractaddress=${USDT_CONTRACT}&sort=desc&page=1&offset=1000`
    );
    expect(txs).toHaveLength(20);
    expect(txs[0].txid.startsWith('0x5e5a9762')).toBe(true);
  });

  it('reads the normal and internal lists for ETH, lowercasing the address', async () => {
    fetchMock.mockImplementation((url: string) =>
      ok(raw(url.includes('action=txlistinternal') ? 'eth-internal-0xf4f8.json' : 'eth-txlist-0xf4f8.json')));
    const txs = await ethereumProvider.fetchNewTxs('0xF4f8d6fB5117CEc024d135d91C012636b814CC07', 'ETH', new Set());
    expect(fetchMock.mock.calls.map(c => c[0])).toEqual([
      `${KEYED}&address=${ADDR}&action=txlist&sort=desc&page=1&offset=1000`,
      `${KEYED}&address=${ADDR}&action=txlistinternal&sort=desc&page=1&offset=1000`,
    ]);
    expect(txs).toHaveLength(33);
  });

  it('skips known hashes in both lists', async () => {
    fetchMock.mockImplementation((url: string) =>
      ok(raw(url.includes('action=txlistinternal') ? 'eth-internal-0xf4f8.json' : 'eth-txlist-0xf4f8.json')));
    const known = new Set([...normal.slice(0, 30), ...internal].map(r => r.hash));
    const txs = await ethereumProvider.fetchNewTxs(ADDR, 'ETH', known);
    expect(txs.map(t => t.txid)).toEqual(normal.slice(30).map(r => r.hash));
  });

  it('reads "No transactions found" as an empty list', async () => {
    fetchMock.mockImplementation(() => ok(empty));
    await expect(ethereumProvider.fetchNewTxs(ADDR, 'ETH', new Set())).resolves.toEqual([]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  const fullPage = (prefix: string) => ({
    status: '1', message: 'OK',
    result: Array.from({ length: 1000 }, (_, i) => ({ ...normal[0], hash: `${prefix}${i}` })),
  });

  it('pages on while a full page has something new', async () => {
    fetchMock.mockImplementation((url: string) =>
      ok(url.includes('page=1&') ? fullPage('0xnew') : raw('eth-usdt-0xf4f8.json')));
    const txs = await ethereumProvider.fetchNewTxs(ADDR, 'USDT', new Set());
    expect(fetchMock.mock.calls.map(c => c[0])).toEqual([
      expect.stringContaining('&page=1&offset=1000'),
      expect.stringContaining('&page=2&offset=1000'),
    ]);
    expect(txs).toHaveLength(1020);
  });

  it('stops at a full page with nothing new', async () => {
    const page = fullPage('0xold');
    fetchMock.mockImplementation(() => ok(page));
    await ethereumProvider.fetchNewTxs(ADDR, 'USDT', new Set(page.result.map(r => r.hash)));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('uses Blockscout without a key, spacing requests a second apart', async () => {
    delete process.env.ETHERSCAN_API_KEY;
    const at: number[] = [];
    fetchMock.mockImplementation(() => {
      at.push(Date.now());
      return ok(empty);
    });
    await ethereumProvider.fetchNewTxs(ADDR, 'ETH', new Set());
    expect(fetchMock.mock.calls[0][0]).toBe(
      `https://eth.blockscout.com/api?module=account&address=${ADDR}&action=txlist&sort=desc&page=1&offset=1000`
    );
    expect(at[1] - at[0]).toBeGreaterThanOrEqual(1000);
  });

  it('uses ETHEREUM_API_URL without a key', async () => {
    delete process.env.ETHERSCAN_API_KEY;
    process.env.ETHEREUM_API_URL = 'https://eth.test/api';
    fetchMock.mockImplementation(() => ok(empty));
    try {
      await ethereumProvider.fetchNewTxs(ADDR, 'USDT', new Set());
      expect(fetchMock.mock.calls[0][0]).toMatch(/^https:\/\/eth\.test\/api\?module=account&/);
    } finally {
      delete process.env.ETHEREUM_API_URL;
    }
  });

  it('spaces keyed requests at least 200 ms apart', async () => {
    const at: number[] = [];
    fetchMock.mockImplementation(() => {
      at.push(Date.now());
      return ok(empty);
    });
    await ethereumProvider.fetchNewTxs(ADDR, 'ETH', new Set());
    expect(at[1] - at[0]).toBeGreaterThanOrEqual(200);
  });

  it.each(['0x123', 'f4f8d6fb5117cec024d135d91c012636b814cc07', 'TPJe9tgEJFsgVTQ4gLjzRTCrQ6pRJYc1aS'])(
    'refuses %s without asking the API', async address => {
      await expect(ethereumProvider.fetchNewTxs(address, 'ETH', new Set()))
        .rejects.toEqual({ statusCode: 400, message: 'Invalid address' });
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  const unavailable = { statusCode: 502, message: 'Blockchain API unavailable' };

  it.each([
    ['Blockscout status 2', { status: '2', message: 'Some internal transactions within this block range have not yet been processed', result: [] }],
    ['NOTOK', { status: '0', message: 'NOTOK', result: 'Max calls per sec rate limit reached (5/sec)' }],
    ['result window', { status: '0', message: 'Result window is too large, PageNo x Offset size must be less than or equal to 10000', result: null }],
  ])('maps %s to 502', async (_name, body) => {
    fetchMock.mockImplementation(() => ok(body));
    await expect(ethereumProvider.fetchNewTxs(ADDR, 'ETH', new Set())).rejects.toEqual(unavailable);
  });

  it.each([429, 500])('maps HTTP %i to 502', async status => {
    fetchMock.mockImplementation(() => Promise.resolve({ ok: false, status, json: async () => ({}) } as Response));
    await expect(ethereumProvider.fetchNewTxs(ADDR, 'USDT', new Set())).rejects.toEqual(unavailable);
  });

  it('maps a body that is not JSON to 502', async () => {
    fetchMock.mockImplementation(() => Promise.resolve({
      ok: true, status: 200, json: async () => { throw new SyntaxError('Unexpected token <'); },
    } as unknown as Response));
    await expect(ethereumProvider.fetchNewTxs(ADDR, 'USDT', new Set())).rejects.toEqual(unavailable);
  });

  it('maps a network error to 502', async () => {
    fetchMock.mockImplementation(() => Promise.reject(new Error('ECONNREFUSED')));
    await expect(ethereumProvider.fetchNewTxs(ADDR, 'ETH', new Set())).rejects.toEqual(unavailable);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npx jest --testPathPatterns=ethereumProvider`
Expected: FAIL — `ethereumProvider` is not exported (TypeScript error in the test file).

- [ ] **Step 3: Add `normalizeAddress` to the interface**

In `backend/src/services/chain/types.ts`, inside `interface ChainProvider`, after `currencies`:

```ts
  /**
   * The canonical form of an address, stored on the account so that one
   * wallet has one spelling (Ethereum: lowercase, as its API returns it).
   * Absent where case matters (base58).
   */
  normalizeAddress?(address: string): string;
```

- [ ] **Step 4: Implement fetching and the provider**

In `backend/src/services/chain/ethereum.ts`, change the import to `import { ChainProvider, ChainTransfer, ChainTx } from './types';` and append:

```ts
interface ApiResponse {
  status: string;
  message: string;
  result: unknown;
}

const PAGE_SIZE = 1000;
const TIMEOUT_MS = 10_000;
// Etherscan's free tier allows 5 requests/s; keyless Blockscout allows only
// about 10 before a several-minute ban, so it is paced like keyless TronGrid.
const KEYED_INTERVAL_MS = 250;
const KEYLESS_INTERVAL_MS = 1_100;
const ADDRESS = /^0x[0-9a-fA-F]{40}$/;

const unavailable = () => ({ statusCode: 502, message: 'Blockchain API unavailable' });

/** Etherscan v2 with a key; any Etherscan-compatible API (Blockscout) without. */
function endpoint(): string {
  const key = process.env.ETHERSCAN_API_KEY;
  if (key) return `https://api.etherscan.io/v2/api?chainid=1&apikey=${encodeURIComponent(key)}&`;
  return `${process.env.ETHEREUM_API_URL || 'https://eth.blockscout.com/api'}?`;
}

let nextRequestAt = 0;

async function getList<T>(query: string): Promise<T[]> {
  const wait = nextRequestAt - Date.now();
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait));
  nextRequestAt = Date.now() + (process.env.ETHERSCAN_API_KEY ? KEYED_INTERVAL_MS : KEYLESS_INTERVAL_MS);

  let body: ApiResponse;
  try {
    const res = await fetch(`${endpoint()}${query}`, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw unavailable();
    body = (await res.json()) as ApiResponse;
  } catch {
    throw unavailable();
  }
  if (body.status === '1' && Array.isArray(body.result)) return body.result as T[];
  if (body.status === '0' && body.message === 'No transactions found') return [];
  // Rate limits, the 10 000-record result window, and Blockscout's status
  // '2' (internal transactions not yet indexed) — the last must not read as
  // "nothing there", or a swap's payout is lost once its hash is seen.
  throw unavailable();
}

/**
 * Every record of the list whose hash is not in `known`, oldest first.
 * Pages run newest first, and a sync records all of its txs as seen or
 * none, so a page with nothing new means everything older was seen too.
 */
async function fetchUnseen<T extends { hash: string }>(query: string, known: ReadonlySet<string>): Promise<T[]> {
  const fresh: T[] = [];
  for (let page = 1; ; page++) {
    const records = await getList<T>(`${query}&sort=desc&page=${page}&offset=${PAGE_SIZE}`);
    const unseen = records.filter(r => !known.has(r.hash));
    fresh.push(...unseen);
    if (records.length < PAGE_SIZE || unseen.length === 0) break;
  }
  return fresh.reverse();
}

export const ethereumProvider: ChainProvider = {
  currencies: { ETH: 8, USDT: 6 },
  normalizeAddress: address => address.toLowerCase(),

  async fetchNewTxs(address, currency, known) {
    // The API answers "No transactions found" for a malformed address.
    if (!ADDRESS.test(address)) throw { statusCode: 400, message: 'Invalid address' };
    const addr = address.toLowerCase();
    const base = `module=account&address=${addr}`;
    if (currency === 'USDT') {
      const records = await fetchUnseen<TokenTransfer>(`${base}&action=tokentx&contractaddress=${USDT_CONTRACT}`, known);
      return tokenToChainTxs(records, addr);
    }
    const normal = await fetchUnseen<EthTx>(`${base}&action=txlist`, known);
    const internal = await fetchUnseen<EthTx>(`${base}&action=txlistinternal`, known);
    return ethToChainTxs(normal, internal, addr);
  },
};
```

- [ ] **Step 5: Register the provider**

In `backend/src/services/chain/index.ts` add `import { ethereumProvider } from './ethereum';` after the tron import and `['ethereum', ethereumProvider],` after `['tron', tronProvider],`.

- [ ] **Step 6: Document the env vars**

Append to `.env.example`:

```
# Ethereum sync: Etherscan v2 when ETHERSCAN_API_KEY is set (free key,
# 5 requests/s); otherwise this Etherscan-compatible API without a key
# (default https://eth.blockscout.com/api — about 10 requests, then a pause).
ETHEREUM_API_URL=https://eth.blockscout.com/api
ETHERSCAN_API_KEY=
```

- [ ] **Step 7: Run to verify it passes, plus the chain suites**

Run: `cd backend && npx jest --testPathPatterns='ethereumProvider|tronProvider|bitcoinProvider|chainSync|chainAdopt'`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add backend/src/services/chain .env.example backend/src/test/ethereumProvider.test.ts
git commit -m "feat(chain): Ethereum provider for ETH and USDT-ERC20 via Etherscan or Blockscout

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 3: Store Ethereum addresses normalised; two ETH wallets merge transfers

**Files:**
- Modify: `backend/src/services/accounts.ts` (`createAccount` ~line 74, `updateAccount` ~line 93, helper next to `assertTrackedShape` ~line 45)
- Test: `backend/src/test/trackedAccounts.test.ts`

**Interfaces:**
- Consumes: `ChainProvider.normalizeAddress` and `ethereumProvider` (Task 2); `syncAccount(userId, accountId)` from `services/chainSync`.

- [ ] **Step 1: Write the failing tests**

In `backend/src/test/trackedAccounts.test.ts` add imports:

```ts
import { ethereumProvider } from '../services/chain/ethereum';
import { syncAccount } from '../services/chainSync';
```

and, inside the top-level `describe` after the `update` describe, a new block (it uses the file's existing `create`, `update`, `seenCount` helpers):

```ts
  describe('ethereum', () => {
    const MIXED = '0xF4f8d6fB5117CEc024d135d91C012636b814CC07';
    const LOWER = MIXED.toLowerCase();
    const eth = (address: string) => ({ type: 'crypto', settings: { address, blockchain: 'ethereum' } });

    it('stores a mixed-case address lowercase', async () => {
      const res = await create({ name: 'E1', currency: 'ETH', startBalance: 0, ...eth(MIXED) });
      expect(res.status).toBe(200);
      expect(res.body.data.tracked).toBe(true);
      expect(res.body.data.scale).toBe(8);
      expect(res.body.data.settings.address).toBe(LOWER);
    });

    it('rejects a currency other than ETH or USDT', async () => {
      const res = await create({ name: 'E2', currency: 'BTC', startBalance: 0, ...eth(MIXED) });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('A blockchain-synced account must be in ETH or USDT');
    });

    it('treats another spelling of the address as the same wallet after a sync', async () => {
      const w = await create({ name: 'E3', currency: 'USDT', startBalance: 0, ...eth(LOWER) });
      await pool.query(`INSERT INTO chain_seen_txids (account_id, txid) VALUES ($1, 'seen1')`, [w.body.data.id]);
      const res = await update(w.body.data.id, { name: 'E3', currency: 'USDT', startBalance: 0, ...eth(MIXED) });
      expect(res.status).toBe(200);
      expect(res.body.data.settings.address).toBe(LOWER);
      expect(await seenCount(w.body.data.id)).toBe(1);
    });

    it('keeps the case of a TRON address', async () => {
      const res = await create({
        name: 'T1', currency: 'TRX', startBalance: 0,
        type: 'crypto', settings: { address: 'TPJe9tgEJFsgVTQ4gLjzRTCrQ6pRJYc1aS', blockchain: 'tron' },
      });
      expect(res.body.data.settings.address).toBe('TPJe9tgEJFsgVTQ4gLjzRTCrQ6pRJYc1aS');
    });

    it('merges a payment between two wallets entered in mixed case into one transfer', async () => {
      const from = '0xAbC0000000000000000000000000000000000001';
      const to = '0xDeF0000000000000000000000000000000000002';
      const a = (await create({ name: 'EA', currency: 'ETH', startBalance: 0, ...eth(from) })).body.data.id;
      const b = (await create({ name: 'EB', currency: 'ETH', startBalance: 0, ...eth(to) })).body.data.id;
      const txid = `0x${'1'.repeat(64)}`;
      // The API gives lowercase addresses, and is asked with the stored one.
      const spy = jest.spyOn(ethereumProvider, 'fetchNewTxs').mockImplementation(async address =>
        address === from.toLowerCase()
          ? [{ txid, date: '2026-10-05', fee: 21, transfers: [{ counterparty: to.toLowerCase(), amount: -500 }] }]
          : [{ txid, date: '2026-10-05', fee: 0, transfers: [{ counterparty: from.toLowerCase(), amount: 500 }] }]
      );
      try {
        await expect(syncAccount(userId, a)).resolves.toMatchObject({ added: 1, fees: 1 });
        await expect(syncAccount(userId, b)).resolves.toMatchObject({ added: 0, merged: 0 });
        const rows = (await pool.query(
          `SELECT debit_account_id, credit_account_id, debit::int FROM transactions WHERE import_hash = $1`, [txid]
        )).rows;
        expect(rows).toEqual([{ debit_account_id: a, credit_account_id: b, debit: 500 }]);
      } finally {
        spy.mockRestore();
      }
    });
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npx jest --testPathPatterns=trackedAccounts`
Expected: FAIL — `stores a mixed-case address lowercase` gets the mixed-case address back; `treats another spelling…` gets 400 "Cannot change the wallet…"; the merge test fails (the mock is asked with the mixed-case address, so it files an income instead of nothing).

- [ ] **Step 3: Implement normalisation**

In `backend/src/services/accounts.ts`, right after `assertTrackedShape`:

```ts
/** Settings with the address in the provider's canonical form, so one wallet has one spelling. */
function normalizeSettings(provider: ChainProvider | null, settings: Record<string, unknown>): Record<string, unknown> {
  return provider?.normalizeAddress
    ? { ...settings, address: provider.normalizeAddress(settings.address as string) }
    : settings;
}
```

In `createAccount`, after `assertTrackedShape(provider, currency, startBalance);` closes its `if`, add:

```ts
  settings = normalizeSettings(provider, settings);
```

In `updateAccount`, directly after `const provider = isTracked(data) ? getProvider(data.settings.blockchain) : null;` add:

```ts
  data = { ...data, settings: normalizeSettings(provider, data.settings) };
```

(`isTracked` already guarantees `settings.address` is a non-empty string whenever `provider` is non-null.)

- [ ] **Step 4: Run to verify it passes, plus the account suites**

Run: `cd backend && npx jest --testPathPatterns='trackedAccounts|accounts|accountScale|accountPurge|chainSync'`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/accounts.ts backend/src/test/trackedAccounts.test.ts
git commit -m "feat(accounts): store Ethereum addresses lowercase so wallets match the chain's spelling

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 4: Adopt matches Ethereum txids written with or without `0x`

**Files:**
- Modify: `backend/src/services/chainAdopt.ts` (`TXID` line 29, `txidOf` ~line 74, `matchRows` ~line 91)
- Test: `backend/src/test/chainAdopt.test.ts`

- [ ] **Step 1: Write the failing test**

In `backend/src/test/chainAdopt.test.ts`, inside `describe('matchRows', …)` after `matches an upper-case txid in the description`:

```ts
  it('matches an Ethereum txid written with or without 0x', () => {
    const hash = `0x${'c'.repeat(64)}`;
    const slots = buildSlots([income(hash, 5000)], none);
    // Amount 1 keeps the heuristic pass from matching instead.
    const row = (description: string) => incomeRow({ credit: 1, debit: 1, description });
    expect(matchRows(A, slots, [row(`paid ${hash}`)]).get(1)?.hash).toBe(hash);
    expect(matchRows(A, slots, [row(`0x${'C'.repeat(64)}`)]).get(1)?.hash).toBe(hash);
    expect(matchRows(A, slots, [row('c'.repeat(64))]).get(1)?.hash).toBe(hash);
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd backend && npx jest --testPathPatterns=chainAdopt`
Expected: FAIL — `undefined` instead of the hash for the `0x` forms.

- [ ] **Step 3: Implement**

In `backend/src/services/chainAdopt.ts` replace `const TXID = /\b[0-9a-f]{64}\b/i;` with:

```ts
// Ethereum hashes carry a 0x prefix; without the optional group there is no
// word boundary between the 'x' and the first hex digit.
const TXID = /\b(?:0x)?[0-9a-f]{64}\b/i;
/** A txid lowercase and without 0x, so either spelling matches. */
const bare = (txid: string) => txid.toLowerCase().replace(/^0x/, '');
```

Replace `txidOf`:

```ts
const txidOf = (row: AccountTxRow): string | undefined => {
  const found = row.description.match(TXID)?.[0];
  return found === undefined ? undefined : bare(found);
};
```

In `matchRows` change `s.txid === txid` to `bare(s.txid) === txid`.

- [ ] **Step 4: Run to verify it passes**

Run: `cd backend && npx jest --testPathPatterns='chainAdopt|chainSync'`
Expected: PASS (the existing bare-txid tests are the regression net).

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/chainAdopt.ts backend/src/test/chainAdopt.test.ts
git commit -m "feat(adopt): match Ethereum txids with or without 0x

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 5: Account form offers Ethereum with ETH or USDT

**Files:**
- Modify: `frontend/src/app/models/account.ts:69-72`
- Test: `frontend/src/app/features/accounts/account-form/account-form.spec.ts`

- [ ] **Step 1: Write the failing test**

In `account-form.spec.ts`, after `keeps an allowed currency when a tron wallet is set`:

```ts
  it('offers ETH and USDT for an ethereum wallet and keeps currency editable', () => {
    const form = createForm({ currency: 'USD' });
    form.form.patchValue({ name: 'MetaMask', currency: 'EUR', startBalance: 5, type: 'crypto', address: '0xF4f8', blockchain: 'ethereum' });

    expect(form.tracked()).toBe(true);
    expect(form.blockchains).toContain('ethereum');
    expect(form.currencyOptions()).toEqual(['ETH', 'USDT']);
    expect(form.form.controls.currency.enabled).toBe(true);
    expect(form.buildPayload()).toMatchObject({ startBalance: 0, currency: 'ETH' });
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `cd frontend && npx ng test --watch=false --include=src/app/features/accounts/account-form/account-form.spec.ts`
Expected: FAIL — `tracked()` is false.

- [ ] **Step 3: Implement**

In `frontend/src/app/models/account.ts`:

```ts
export const SYNCED_CHAINS: Readonly<Record<string, readonly string[]>> = {
  bitcoin: ['BTC'],
  tron: ['TRX', 'USDT'],
  ethereum: ['ETH', 'USDT'],
};
```

- [ ] **Step 4: Run to verify it passes**

Run: `cd frontend && npx ng test --watch=false --include=src/app/features/accounts/account-form/account-form.spec.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add frontend/src/app/models/account.ts frontend/src/app/features/accounts/account-form/account-form.spec.ts
git commit -m "feat(account-form): Ethereum wallets choose ETH or USDT

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```

---

### Task 6: Docs and live check on a copy of the dev database

**Files:**
- Modify: `CLAUDE.md` ("Blockchain-synced (tracked) accounts")
- Scratch (not committed): `<scratchpad>/eth-live.ts`

- [ ] **Step 1: Update CLAUDE.md**

In "Blockchain-synced (tracked) accounts", change `(today `bitcoin` and `tron`, see` to `(today `bitcoin`, `tron` and `ethereum`, see`; change

```markdown
at `BITCOIN_ESPLORA_URL`; `services/chain/tron.ts`, TronGrid at
`TRON_API_URL`) and
```

to

```markdown
at `BITCOIN_ESPLORA_URL`; `services/chain/tron.ts`, TronGrid at
`TRON_API_URL`; `services/chain/ethereum.ts`, Etherscan v2 when
`ETHERSCAN_API_KEY` is set, else Blockscout at `ETHEREUM_API_URL`) and
```

and change `(TRON: `TRX` or `USDT`, each synced separately; TRON fees always land on the TRX account)` to `(TRON: `TRX` or `USDT`, Ethereum: `ETH` or `USDT`, each synced separately; fees always land on the TRX / ETH account; Ethereum addresses are stored lowercase and ETH amounts are rounded from wei to 1e-8)`.

- [ ] **Step 2: Copy the dev database**

```bash
docker exec swarmer-finance-postgres-1 createdb -U finance_user finance_db_eth_check
docker exec swarmer-finance-postgres-1 sh -c "pg_dump -U finance_user finance_db_nu | psql -q -U finance_user finance_db_eth_check"
```

Expected: no errors. Do **not** touch `finance_db_nu`.

- [ ] **Step 3: Run the live check script**

Write `<scratchpad>/eth-live.ts`:

```ts
import { pool } from '/home/dmitry/projects/swarmer-finance/backend/src/db';
import { createAccount } from '/home/dmitry/projects/swarmer-finance/backend/src/services/accounts';
import { syncAccount } from '/home/dmitry/projects/swarmer-finance/backend/src/services/chainSync';

const MIXED = '0xF4f8d6fB5117CEc024d135d91C012636b814CC07';
const ADDR = MIXED.toLowerCase();
const balance = async (id: number) => Number((await pool.query(
  `SELECT COALESCE(SUM(CASE WHEN credit_account_id = $1 THEN credit ELSE 0 END), 0)
        - COALESCE(SUM(CASE WHEN debit_account_id = $1 THEN debit ELSE 0 END), 0) AS b
   FROM transactions WHERE $1 IN (debit_account_id, credit_account_id)`, [id])).rows[0].b);
const rowCount = async (id: number) => Number((await pool.query(
  `SELECT count(*) FROM transactions WHERE $1 IN (debit_account_id, credit_account_id)`, [id])).rows[0].count);
const chain = async (query: string) => {
  const res = await fetch(`https://api.etherscan.io/v2/api?chainid=1&apikey=${process.env.ETHERSCAN_API_KEY}&module=account&${query}&tag=latest`);
  return BigInt(((await res.json()) as { result: string }).result);
};

(async () => {
  const eth = await createAccount(2, 'Check / ETH', 'ETH', 0, 'crypto', { address: MIXED, blockchain: 'ethereum' });
  console.log('stored address', eth.settings);
  console.log('ETH sync 1', await syncAccount(2, eth.id));
  console.log('ETH sync 2', await syncAccount(2, eth.id));
  const ethRows = await rowCount(eth.id);
  const ethChain = await chain(`action=balance&address=${ADDR}`);
  console.log('ETH balance', await balance(eth.id), 'chain wei', ethChain, 'rows', ethRows);

  const usdt = await createAccount(2, 'Check / USDT', 'USDT', 0, 'crypto', { address: MIXED, blockchain: 'ethereum' });
  console.log('USDT sync 1', await syncAccount(2, usdt.id));
  console.log('USDT sync 2', await syncAccount(2, usdt.id));
  const usdtChain = await chain(`action=tokenbalance&contractaddress=0xdac17f958d2ee523a2206206994597c13d831ec7&address=${ADDR}`);
  console.log('USDT balance', await balance(usdt.id), 'chain', usdtChain);
  await pool.end();
})().catch(async e => { console.error(e); await pool.end(); process.exit(1); });
```

Run (the backend `.env` supplies `ETHERSCAN_API_KEY`; take the user/password from `backend/.env`'s `DATABASE_URL`):
`cd backend && DATABASE_URL=postgresql://<user>:<password>@localhost:5432/finance_db_eth_check npx tsx <scratchpad>/eth-live.ts`

Expected (spec success criteria):
- `stored address` shows `0xf4f8d6fb5117cec024d135d91c012636b814cc07`.
- `ETH sync 1` adds incomes, expenses and fees — at least the fixture's 15 / 7 / 15 (the wallet is live and may have more); `ETH sync 2` → all zeros.
- `|ETH balance − round(chain wei / 1e10)| ≤ ceil(rows / 2)` (0.5e-8 per row).
- `USDT sync 1` → at least 20 added, `fees: 0`; `USDT sync 2` → all zeros; `USDT balance` equals `chain` exactly.

Report any mismatch to the user instead of adjusting expectations.

- [ ] **Step 4: Drop the copy**

```bash
docker exec swarmer-finance-postgres-1 dropdb -U finance_user finance_db_eth_check
```

- [ ] **Step 5: Run the full suites**

Run: `cd backend && npm test` and `cd frontend && npm test -- --watch=false`
Expected: all PASS.

- [ ] **Step 6: Commit the docs**

```bash
git add CLAUDE.md
git commit -m "docs: Ethereum sync in CLAUDE.md

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>"
```
