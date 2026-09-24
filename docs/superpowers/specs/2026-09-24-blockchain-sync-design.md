# Blockchain sync for crypto accounts

**Date:** 2026-09-24
**Status:** Draft, awaiting review
**Scope:** Backend (new sync service, rules in accounts/transactions services,
migration 012) and frontend (sync button, account form, transaction form).
First chain: Bitcoin.

## Problem

`crypto` accounts already exist (migration 008, `settings: { address,
blockchain }`), but their transactions are typed in by hand. For a wallet the
blockchain is the source of truth: every movement, its date and its fee are
public. Hand entry duplicates that work and drifts from the real balance.

## Goal

A crypto account that points at a wallet address loads its transactions from
the blockchain on user request. What the chain states (dates, amounts, fees,
which tracked wallets were involved) cannot be edited; what the chain cannot
know (category, where the money went off-chain, notes) can.

Success: syncing `bc1q3yxr3gkes4nmjvtmn5h5qasyh7jzusxzezys75` yields 136
income transactions and a balance of 0.08220906 BTC (its `funded_txo_sum` on
2026-09-24), and a second sync adds nothing.

## Terms

**Tracked account** — `type = 'crypto'`, non-empty `settings.address`, and
`settings.blockchain` present in the provider registry (today: `bitcoin`).
All rules below apply to tracked accounts only. A crypto account without an
address (e.g. an exchange balance) behaves like any other account.

## Rules

1. A tracked account's `start_balance` is 0 and cannot be changed.
2. Transactions on a tracked account cannot be created or deleted by hand.
   On an existing one the user may change only:
   - `category_id`, when the row is an expense or income;
   - the other account (null ↔ account), turning expense/income into a
     transfer and back;
   - the other side's amount, only when the other account's currency differs
     from the tracked account's; with the same currency it is forced equal to
     the tracked side;
   - `description` (always).
3. A transfer whose both sides are tracked accounts is one transaction; only
   its `description` can be edited.
4. Sync runs on user request (button in the account tree), never on a
   schedule.

State transitions of an account:

- **Create tracked:** `startBalance` must be 0; currency must be the chain's
  native currency (`BTC` for `bitcoin`); `scale` is forced to 8.
- **Make an existing account tracked:** allowed only when it has no
  transactions and `start_balance = 0`; otherwise 400 ("create a new account").
- **Change `address`/`blockchain` of a tracked account:** allowed only when it
  has no transactions.
- **Remove the address (untrack):** allowed. Existing rows stay and become
  ordinary editable transactions. This is the escape hatch for a wallet that
  moved.

## Architecture

```
AccountTreeNode [Sync] → POST /api/accounts/:id/sync (routes/sync.ts)
  → services/chainSync.ts  — maps ChainTx → ledger rows, merges, writes
      → services/chain/index.ts   — registry { bitcoin: bitcoinProvider }
      → services/chain/bitcoin.ts — Esplora client, UTXO → ChainTx
      → db/queries/transactions   — reads/writes by import_hash
```

### Provider interface

UTXO specifics stay inside the provider; the sync service sees a normalised,
chain-agnostic shape that an account-based chain (ETH-like) maps to almost
directly.

```ts
interface ChainTx {
  txid: string;
  date: string;       // YYYY-MM-DD, UTC date of the block time
  fee: bigint;        // paid by this address; 0 when it did not pay
  // Net movement per counterparty, base units: + received from, − sent to.
  transfers: { counterparty: string; amount: bigint }[];
}

interface ChainProvider {
  currency: string;   // native currency, e.g. 'BTC'
  scale: number;      // 8 for BTC
  fetchNewTxs(address: string, knownTxids: Set<string>): Promise<ChainTx[]>;
}
```

The registry also drives validation of `settings.blockchain` and the
blockchain select in the account form.

### Bitcoin provider

- Esplora REST API, base URL from env `BITCOIN_ESPLORA_URL`, default
  `https://mempool.space/api`.
- `GET /address/:addr/txs/chain` then `/txs/chain/:last_txid` — confirmed
  transactions only, newest first, 25 per page. Unconfirmed ones are skipped
  and picked up by a later sync.
- Incremental: paging stops at the first page whose txids are all in
  `knownTxids`. Unique indexes on `import_hash` stay the final guard.
- Per tx, for the account address `S`: `in` = sum of inputs from `S`,
  `out` = sum of outputs to `S`.
  - `in = 0`: received. One transfer entry `{ counterparty: first input
    address, amount: out }`.
  - `in > 0`: we paid, `fee = tx.fee`. Each output not to `S` becomes
    `{ counterparty: output address, amount: −value }` (change to `S` is not a
    movement). Outputs without an address (OP_RETURN) are ignored unless they
    carry value, in which case the counterparty is `''`.
- Request timeout 10 s. Network error, timeout, 5xx or 429 → 502
  "Blockchain API unavailable". Esplora 400 on the address → 400
  "Invalid address".

### Mapping ChainTx to ledger rows (chainSync)

`import_hash` identifies synced rows. For tracked account `A` and one
`ChainTx`:

| Case | Row(s) | import_hash |
|------|--------|-------------|
| Positive entries (received) | income on A, `credit = sum` | `txid` |
| Negative entries to a tracked account B | transfer A → B, `debit = credit = amount to B` | `txid` |
| Negative entries to anyone else | one expense on A, `debit = sum of them` | `txid`, or `txid:out` when a transfer row already uses `txid` |
| `fee > 0` | expense on A, category Network fees (id 5) | `txid:fee` |

- A consolidation (all outputs back to `S`) produces only the fee row.
- "Tracked account B" = a tracked account on the same chain with that address
  on which the syncing user holds at least WRITE.
- `payee` = the counterparty address (for an expense aggregating several
  counterparties, the first one).
- `description` = `''`.
- Category for income/expense rows comes from the import category suggester
  (`suggestCategories`, voting over the user's history by `payee`); when it
  has no confident answer, Uncategorized (3 / 4).
- `date` = `ChainTx.date`; `user_id` = the syncing user.

**Merge by txid across tracked accounts.** Before inserting, the sync looks up
rows with `import_hash = txid` on every tracked account the user can write.

- Syncing A finds an income row on B for the same txid (B was synced first):
  that row is converted into the transfer A → B instead of inserting a new one.
- Syncing B sees a positive entry from A's address and finds A's expense row
  with `import_hash = txid` (A was synced first, when B was not tracked or not
  yet synced): that row becomes the transfer A → B for the amount B received.
  If the expense was larger (it also paid third parties), the remainder is
  inserted as an expense on A with hash `txid:out` — the same rows a fresh
  sync of A would now produce.
- If the user had meanwhile turned that expense into a transfer to some
  untracked account X, rule 3 wins: the other side is overwritten with B.
- A row that already exists in the correct shape is left untouched (idempotent
  re-sync); user-set category and description are never overwritten.

All inserts and conversions of one sync run in a single Postgres transaction.
The provider call completes before the DB transaction starts, so a paging
failure writes nothing.

Response: `{ added, merged, fees }` — counts of new main rows, converted rows,
and new fee rows.

## Rule enforcement

Helper `isTracked(account)` in a small module shared by accounts and
transactions services. The account DTO gains a computed `tracked: boolean`
so the frontend does not re-implement the registry check.

**`services/accounts.ts`** — create/update checks listed under "State
transitions". Validation errors are 400.

**`services/transactions.ts`**

- `create`: any referenced account tracked → 403 "Transactions of this
  account are loaded from the blockchain".
- `delete`: same.
- `update` of a row touching a tracked account: compare the incoming values
  with the stored row; any change outside the list in rule 2 (date, tracked
  side amount, payee, replacing the tracked account itself) → 400. Rows with
  both sides tracked allow only `description`.
- Existing rules still apply on top (a transfer has no category; income/
  expense needs one).

**`services/categories.ts`** — the system-category guard (`id` 1–4) extends to
5, so Network fees cannot be renamed or deleted.

## Migration 012

```sql
INSERT INTO categories (id, user_id, name, color, icon, parent_id)
VALUES (5, NULL, 'Network fees', '#888888', 'bitcoin', 2);
```

No `ON CONFLICT`: migration 002 set `categories_id_seq` to `MAX(id) + 10`
(= 12), so id 5 was never handed out; if it somehow is taken, the migration
must fail loudly rather than silently skip.

## Frontend

- **`AccountTreeNode`:** for `account.tracked`, a "Sync" icon button
  (`@tui.refresh-cw`) with the same hover markup as Import. Loading state
  while the request runs; on success a notification ("Added 12, fees 3,
  merged 1" / "Up to date") and a reload of `AccountsState` and
  `TransactionsState`; on error the backend message.
- **`AccountForm`:** `blockchain` becomes a select of supported chains plus
  empty. When address and chain are set: `startBalance` is 0 and disabled,
  currency is set to the chain's and disabled, scale 8.
- **Transactions:** for a tracked account, hide "add" and "delete"; in the
  edit form disable every field outside rule 2. The backend stays the source
  of truth.

## Testing

**Backend (Jest)** — network mocked by replacing `fetch`; fixtures in
`backend/src/test/fixtures/chain/`:

- recorded Esplora pages for `bc1q3yxr…ys75` (incoming batch payouts);
- synthetic txs: outgoing with change, consolidation, A → B between two
  tracked addresses, outgoing to B plus a third party.

Cases:

- provider: `ChainTx` shape per fixture; pagination stops on a known page;
  unconfirmed skipped; error mapping (timeout, 429, 400).
- chainSync: income, expense + fee row, transfer, mixed transfer + expense,
  consolidation, merge A-first and B-first, overwrite of a manual transfer to
  X, repeat sync is a no-op, suggested category applied, user-set category
  kept.
- rules via `testApp`: create/delete forbidden, each allowed and forbidden
  update field, both-tracked transfer, account state transitions, Network
  fees protected.

**Frontend (Vitest)** — Sync button only for `tracked`; account form locks
start balance/currency when tracked; transaction form disables locked fields.

**Manual** — live sync of the test address: 136 incomes, balance
0.08220906 BTC, second sync reports "Up to date".

## Out of scope

- HD wallets / xpub (one account = one address).
- Chains other than Bitcoin (the interface is ready for them).
- Scheduled or background sync.
- Lightning, token transfers.
