# Blockchain sync for TRON (TRX and USDT-TRC20)

**Date:** 2026-09-25
**Status:** Draft, awaiting review
**Builds on:** `2026-09-24-blockchain-sync-design.md`,
`2026-09-25-adopt-transactions-on-tracking-design.md`
**Scope:** Backend (provider interface, new TRON provider, account rules,
sync peers) and frontend (account form). No migration.

## Problem

Bitcoin wallets sync from the chain; TRON wallets are still typed in by hand.
Unlike Bitcoin, one TRON address holds several assets: native TRX and TRC20
tokens, of which USDT is the one in use. The provider interface assumes one
currency per chain.

## Goal

A `crypto` account with `settings.blockchain = 'tron'` and an address syncs
the transactions in **its own currency**: a `TRX` account syncs native TRX
movements, a `USDT` account syncs transfers of the USDT TRC20 contract. One
address may have two accounts, one per currency.

Success, on address `TPJe9tgEJFsgVTQ4gLjzRTCrQ6pRJYc1aS` (dev account #81,
USDT, 7 hand-entered rows each carrying its txid in the description):

- switching #81 to tracked and syncing adopts all 7 rows, removes none, and
  the balance is 36985.002 USDT (the chain's TRC20 balance on 2026-09-25);
- a new TRX account on the same address syncs 7 incomes (one of 25 TRX, six
  of 1–7 sun dust) and one Network fees row of 13.0285 TRX; balance
  11.971521 TRX, the chain's balance;
- a second sync of either account reports "Up to date".

## Decisions

1. **Fees go to the TRX account.** TRON gas (burned bandwidth/energy) is
   always paid in TRX, including for a USDT transfer. A TRX account records a
   `txid:fee` row for every transaction its address sent, whatever the
   contract. A USDT account never records fees. Without a tracked TRX account
   on the address, fees are not recorded anywhere.
2. **Dust is imported as is.** Address-poisoning transfers of a few sun are
   real movements; importing them keeps the balance equal to the chain's.
3. **Wallet identity is `address` + `blockchain` + `currency`.** Two accounts
   on the same address in different currencies are separate wallets: they are
   not sync peers and a currency change is treated like an address change.

## Provider interface

The provider declares the currencies it can sync, and sync passes the
account's currency in:

```ts
interface ChainProvider {
  /** Currencies a tracked account on this chain may use, with their scale. */
  currencies: Readonly<Record<string, number>>;
  /** Confirmed transactions of `address` in `currency` not in `known`, oldest first. */
  fetchNewTxs(address: string, currency: string, known: ReadonlySet<string>): Promise<ChainTx[]>;
}
```

`ChainTx` is unchanged. Bitcoin becomes `currencies: { BTC: 8 }` and ignores
`currency`. The registry gains `tron`.

## TRON provider (`services/chain/tron.ts`)

- TronGrid REST API, base URL from env `TRON_API_URL` (default
  `https://api.trongrid.io`); when env `TRONGRID_API_KEY` is set it is sent as
  header `TRON-PRO-API-KEY`. `currencies: { TRX: 6, USDT: 6 }`.
- Query `limit=200&only_confirmed=true`; pages run newest first and continue
  via `meta.fingerprint`. Paging stops at a page with no unseen txid or with
  no fingerprint, as for Bitcoin.
- Request timeout 10 s. Network error, timeout, 5xx or 429 → 502 "Blockchain
  API unavailable"; TronGrid 400 → 400 "Invalid address".
- Block time: `block_timestamp` (ms) → UTC `YYYY-MM-DD`.

### USDT account

`GET /v1/accounts/:addr/transactions/trc20?contract_address=TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t`.
The contract address is a constant in `tron.ts`; transfers of any other token
(including fakes named "USDT") are ignored, and the provider also drops
records whose `token_info.address` differs, in case the filter is ignored.

Records are grouped by `transaction_id` into one `ChainTx`:
`to == addr` → `{ counterparty: from, amount: +value }`; `from == addr` →
`{ counterparty: to, amount: −value }`; a transfer to itself is dropped. A
transaction with nothing left is still returned, with no transfers: it plans
to no rows but is recorded as seen, so paging can stop on it.
`fee = 0` (decision 1). Addresses in this endpoint are already base58.

### TRX account

`GET /v1/accounts/:addr/transactions`. Addresses in `raw_data` are hex
(`41…`; `visible=true` does not change that), so they are converted to
base58check (`41`-prefixed 21 bytes + first 4 bytes of double SHA-256, base58
encoded) — a small helper on `node:crypto`.

Per transaction, `c = raw_data.contract[0]`, `ok = ret[0].contractRet === 'SUCCESS'`:

- `TransferContract`, `ok`: `to == addr` → `+amount` from owner;
  `owner == addr` → `−amount` to `to`.
- `TriggerSmartContract`, `ok`, `owner == addr`, `call_value > 0`:
  `−call_value` to the contract address.
- `fee = ret[0].fee` when `owner == addr`, else 0 — the sender of an incoming
  transfer pays its own fee. This covers USDT sends, failed transactions and
  any other contract type.
- Anything else (freeze/unfreeze, votes, reward withdrawal, TRC10, internal
  transactions) contributes no transfer; only its fee, per the rule above.

A transaction with no transfers and no fee (e.g. an incoming TRC20 transfer
that shows up in this list) yields a `ChainTx` that plans to nothing; it is
still recorded as seen.

## Account rules (`services/accounts.ts`)

- `assertTrackedShape`: the currency must be a key of `provider.currencies`;
  otherwise 400 "A blockchain-synced account must be in TRX or USDT" (the
  list joined from the provider). The scale still comes from
  `getCurrencyScale` (TRX 6, USDT 6, BTC 8 — equal to the provider's).
- `sameWallet` also requires `existing.currency === currency`. Consequences,
  through the existing branches:
  - tracked account with seen txids: a currency change → 400 "Cannot change
    the wallet of an account that already has transactions";
  - tracked account never synced: a currency change is a wallet switch —
    seen txids cleared, next sync reconciles.
- `isTracked` is unchanged. A TRON account in an unsupported currency (only
  possible via direct SQL) is refused by sync's scale check.

## Sync (`services/chainSync.ts`)

- The scale check reads `provider.currencies[account.currency]`; an
  undefined scale fails it like a mismatch.
- `provider.fetchNewTxs(address, account.currency, known)`.
- `loadPeers`: a peer must match `blockchain` **and** `currency`. The TRX
  and USDT accounts of one address are not peers.
- `planTx`, `apply`, merging and `chainAdopt` are unchanged. The unique
  `import_hash` indexes are per account, so the TRX account's `txid:fee` and
  the USDT account's `txid` for the same transaction do not collide.

## Frontend

- `models/account.ts`: `SYNCED_CHAINS: Record<string, readonly string[]>` =
  `{ bitcoin: ['BTC'], tron: ['TRX', 'USDT'] }`.
- `AccountForm.applyTrackedLock` when tracked: start balance 0 and disabled
  (as now); currency:
  - one allowed currency → set it and disable the control (Bitcoin, as now);
  - several → the combo box lists only them; a current value outside the
    list is replaced by the first; the control stays enabled.

The Sync button and the transaction-form locks already follow
`account.tracked` and need no change.

## Testing

**Backend (Jest)**, fetch mocked; fixtures in
`backend/src/test/fixtures/chain/` recorded from TronGrid for
`TPJe9t…c1aS` (TRC20 and TRX lists):

- provider: USDT list → 7 `ChainTx`, fake token dropped; TRX list → 7
  incomes, the USDT send as fee-only 13028500, the incoming 25 TRX without
  the sender's 1.1 TRX fee; hex → base58 for known pairs; fingerprint paging
  stops on a known page; error mapping.
- sync: TRX account files the fee of a USDT send; TRX and USDT accounts on
  one address do not merge; a transfer between two tracked USDT wallets
  merges as for Bitcoin.
- account rules: currency outside the provider's list → 400; currency change
  after a sync → 400; before any sync → accepted, seen txids cleared;
  Bitcoin behaviour unchanged.

**Frontend (Vitest)**: tron offers TRX/USDT and keeps currency enabled,
replacing an outside value; bitcoin still locks BTC.

**Manual**, on a copy of the dev database (`CREATE DATABASE … TEMPLATE
finance_db_nu`) with a temporary backend on :3001: the success criteria
above for #81 and a new TRX account.

## Out of scope

- Staking (freeze/unfreeze, delegation), votes and reward withdrawal:
  their TRX movements are not recorded, only their fees, so a staking
  wallet's TRX balance can differ from the chain's.
- TRC10 tokens, TRC20 tokens other than USDT, internal transactions.
- USDT on other chains.
