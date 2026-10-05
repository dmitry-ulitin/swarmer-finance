# Blockchain sync for Ethereum (ETH and USDT-ERC20)

**Date:** 2026-10-05
**Status:** Draft, awaiting review
**Builds on:** `2026-09-24-blockchain-sync-design.md`,
`2026-09-25-adopt-transactions-on-tracking-design.md`,
`2026-09-25-tron-sync-design.md`
**Scope:** Backend (new Ethereum provider, address normalisation, adopt's
txid match) and frontend (one entry in `SYNCED_CHAINS`). No migration.

## Problem

Bitcoin and TRON wallets sync from the chain; Ethereum wallets are still typed
in by hand. Like TRON, one Ethereum address holds native ETH and ERC20
tokens, of which USDT is the one in use. Unlike TRON, Ethereum addresses are
case-insensitive hex (users paste the mixed-case checksum form, APIs return
lowercase), and transaction hashes carry a `0x` prefix.

## Goal

A `crypto` account with `settings.blockchain = 'ethereum'` and an address
syncs the transactions in **its own currency**: an `ETH` account syncs ETH
movements and gas, a `USDT` account syncs transfers of the USDT ERC20
contract. One address may have two accounts, one per currency.

Success, on address `0xF4f8d6fB5117CEc024d135d91C012636b814CC07` (entered in
mixed case). The wallet is live, so exact counts are pinned by fixtures
recorded on 2026-10-05 (32 normal transactions, 1 internal, 20 USDT
transfers):

- those fixtures give an ETH account 15 incomes, 7 expenses and 15 Network
  fees rows; the internal transfer (1000000000 wei = 1e-9 ETH) rounds to 0
  and files nothing (decision 4); the rows net to 0.00021651 ETH against the
  chain's 216504585876843 wei = 0.00021650 ETH (rounding);
- the same fixtures give a USDT account 20 rows, no fees, netting to
  0.00005 USDT, the chain's balance exactly;
- manually, on the live chain: the synced ETH account's balance is the
  chain's within 0.5e-8 ETH per row, the USDT account's exactly; the stored
  address of both accounts is lowercase; a second sync of either reports
  "Up to date".

## Decisions

1. **Fees go to the ETH account**, as on TRON: gas is always paid in ETH, so
   the ETH account records a `txid:fee` row for every transaction its address
   sent, USDT sends and failed transactions included. A USDT account never
   records fees.
2. **Incoming internal transfers are synced.** ETH paid out by a contract
   (exchange withdrawals through a contract, DEX swaps paying out ETH, Safe
   wallets) is real income; without it such a wallet's balance drifts from
   the chain's. Outgoing internal transfers are not fetched: an ordinary
   wallet (EOA) cannot make one.
3. **Etherscan with a key, Blockscout without.** Etherscan v2 no longer
   answers without an API key; Blockscout serves the same Etherscan-compatible
   API keyless but allows only ~10 requests before a ~8 minute ban. One
   provider speaks that API to whichever is configured.
4. **Wei is rounded to the account's scale.** ETH is stored with scale 8
   (`currencyScale.ts`: JS numbers hold ~15 significant digits), so each
   amount and fee is rounded half-up from wei to 1e-8 ETH. The account's
   balance can differ from the chain's by up to 0.5e-8 ETH per row. A
   movement or fee that rounds to 0 is dropped (rows must be positive); its
   transaction is still returned and recorded as seen.
5. **Addresses are stored normalised.** An Ethereum address is lowercased on
   save, so a checksum address typed by the user and the lowercase one the API
   returns name the same wallet (`sameWallet`, sync peers, transfer merging).
   Base58 addresses (Bitcoin legacy, TRON) are case-sensitive and stay as
   typed.

## Provider interface

`ChainProvider` gains an optional method:

```ts
/** The canonical form of an address, stored on the account; identity when absent. */
normalizeAddress?(address: string): string;
```

Only Ethereum implements it (`address.toLowerCase()`).

## Ethereum provider (`services/chain/ethereum.ts`)

- `currencies: { ETH: 8, USDT: 6 }`. Registered as `ethereum` in
  `services/chain/index.ts`.
- **Endpoint.** When env `ETHERSCAN_API_KEY` is set, requests go to
  `https://api.etherscan.io/v2/api?chainid=1&apikey=<key>&…`; otherwise to env
  `ETHEREUM_API_URL` (default `https://eth.blockscout.com/api`) with no key.
- **Pacing.** Requests are spaced ≥ 500 ms apart with a key (Etherscan's free
  tier allows 3/s) and ≥ 1.1 s without (across pages and across syncs in the
  same process), like TronGrid's keyless spacing.
- **Errors.** Request timeout 10 s. Network error, timeout, non-2xx, a body
  that is not JSON, or `status` other than `"1"` → 502 "Blockchain API
  unavailable" — except `status "0"` with an empty array `result`, which is an
  empty list (Etherscan says "No transactions found", Blockscout words it per
  list, so the shape decides, not the message). This covers rate limits, Etherscan's "Result window
  is too large" (more than 10 000 records in one list) and Blockscout's
  `status "2"` ("internal transactions … not yet processed"), which must not
  be read as "nothing there" or the swap's payout would be lost once its hash
  is seen.
- **Address.** Must match `/^0x[0-9a-fA-F]{40}$/`, else 400 "Invalid
  address" before any request (the API answers "No transactions found" for a
  malformed one). All comparisons use the lowercase address; API addresses
  are lowercase already.
- **Confirmations.** Each sync first asks for the head block
  (`module=block&action=getblocknobytime&timestamp=<now>&closest=before`) and
  reads every list with `startblock=0&endblock=<head − 12>`: records nearer the
  head may still be reorged away or lack their indexed internal transfers, and
  one fixed range keeps a transaction landing mid-paging from shifting pages.
- **Paging.** `module=account&sort=desc&page=N&offset=1000`. Paging stops at
  a page with no unseen hash or one shorter than `offset`, as for TRON.
  Records come back oldest first.
- **Date.** `timeStamp` (seconds) → UTC `YYYY-MM-DD`.
- **Amounts.** Read as `BigInt` from the decimal strings. USDT (6 decimals)
  values are used as is; wei values become `Number((wei + 5·10⁹) / 10¹⁰)`.
  A value or fee that becomes 0 is not added (decision 4).
- **txid.** The hash as the API returns it: `0x` + 64 lowercase hex, the form
  Etherscan shows.

### USDT account

`action=tokentx&address=<addr>&contractaddress=0xdac17f958d2ee523a2206206994597c13d831ec7`.
Records whose `contractAddress` differs are dropped in case the filter is
ignored. Records are grouped by `hash` into one `ChainTx`: `to == addr` →
`+value` from `from`; `from == addr` → `−value` to `to`; a transfer to itself and a zero-value one (address
poisoning) are dropped. A transaction with nothing left is still returned, with no
transfers, so it is recorded as seen. `fee = 0` (decision 1).

### ETH account

Two lists, `action=txlist` and `action=txlistinternal`, each paged as above
against the same `known` set, then merged by `hash` into one `ChainTx` per
transaction, ordered by block (`blockNumber`, then the order within the
lists).

Normal transaction (`txlist`), `ok = isError === '0'`:

- `ok`, `to == addr`, `from != addr`, `value > 0` → `+value` from `from`;
- `ok`, `from == addr`, `to != addr`, `value > 0` → `−value` to `to` (this
  includes ETH sent with a contract call);
- `fee = gasUsed × gasPrice` when `from == addr`, whatever the outcome or the
  call; else 0. (`gasPrice` in these lists is the effective price paid.)
- Contract creation (`to` empty) moves no value here; only its fee.

Internal transaction (`txlistinternal`): `isError === '0'`, `to == addr`,
`value > 0` → `+value` from `from`. Anything else is ignored (decision 2).

`planTx` files a transaction as income when anything comes in, ignoring what
went out (a Bitcoin or TRON transaction never does both for one address). An
Ethereum transaction can — a DEX refunding excess ETH as an internal
transfer — so one with both incoming and outgoing ETH is netted to a single
transfer: the sum, with the counterparty of the largest movement on the
winning side; a sum of 0 leaves no transfers.

A transaction with no transfers and no fee is still returned, so it is
recorded as seen. Hashes from both lists go into `chain_seen_txids` through
the existing sync; a swap whose own transaction and internal payout share a
hash becomes one `ChainTx` with a fee and an income.

`planTx` already handles a plan with both an income and a fee (the fee row is
filed independently), so sync needs no change for that case.

## Account rules (`services/accounts.ts`)

- Before any other check, a tracked account's `settings.address` is replaced
  by `provider.normalizeAddress(address)` when the provider has one. The
  normalised value is what is compared (`sameWallet`) and stored.
- Address-format validation stays in the provider (at sync), as for TRON.
- `assertTrackedShape` is unchanged; its message lists the provider's
  currencies ("must be in ETH or USDT").

## Adopt (`services/chainAdopt.ts`)

`TXID = /\b[0-9a-f]{64}\b/i` misses `0x…` (there is no word boundary between
`x` and a hex digit). It becomes `/\b(?:0x)?[0-9a-f]{64}\b/i`, and a row's
txid and a slot's txid are compared without the `0x` prefix (a `bare()`
helper lowercasing and stripping it), so a description holding the hash with
or without `0x` matches. Bitcoin and TRON txids have no prefix and match as
before.

## Frontend

`models/account.ts`: `SYNCED_CHAINS` gains `ethereum: ['ETH', 'USDT']`. The
account form already handles a chain with several currencies (TRON).

## Configuration

`.env.example` gains:

```
# Ethereum sync: Etherscan v2 when ETHERSCAN_API_KEY is set (free key,
# 3 requests/s); otherwise this Etherscan-compatible API without a key
# (default https://eth.blockscout.com/api — about 10 requests, then a pause).
ETHEREUM_API_URL=https://eth.blockscout.com/api
ETHERSCAN_API_KEY=
```

## Testing

**Backend (Jest)**, fetch mocked; fixtures in
`backend/src/test/fixtures/chain/` recorded from Etherscan for
`0xf4f8…cc07` (`txlist`, `txlistinternal`, `tokentx`), plus synthetic
records added in the tests (a failed transaction, an internal payout of a
swap sharing its hash with our own transaction, a record of another token):

- provider: USDT list → 20 `ChainTx` netting to 50, a record of another
  contract dropped; ETH lists → 33 `ChainTx`: 15 incomes, 7 expenses, 15
  fees, the 1e-9 ETH internal transfer as an empty `ChainTx`; a swap's
  internal payout merged into our transaction with its fee; a refund netted
  against what was sent; the failed
  transaction yields its fee only; wei rounding half-up;
  paging stops on a known page and on a short page; "No transactions found"
  is empty; `status "2"`, `NOTOK`, non-JSON and 429 → 502; malformed address
  → 400 without a request; Etherscan URL and key used when the key is set,
  `ETHEREUM_API_URL` otherwise.
- account rules: a mixed-case Ethereum address is stored lowercase and is
  the same wallet as its lowercase form; a TRON address keeps its case.
- adopt: a description with `0x<hash>` and one with the bare hash both adopt
  the matching Ethereum slot; Bitcoin txid matching unchanged.
- sync: two ETH wallets created with mixed-case addresses merge a payment
  between them (counterparties lowercase, as the API gives them) into one
  transfer.

**Frontend (Vitest)**: `ethereum` offers ETH/USDT and keeps the currency
control enabled.

**Manual**, on a copy of the dev database (`CREATE DATABASE … TEMPLATE
finance_db_nu`) with a temporary backend on :3001: the success criteria above.

## Out of scope

- ERC20 tokens other than USDT (USDC, …), NFTs.
- Outgoing internal transfers (contract wallets as the tracked address).
- L2s and other EVM chains (Arbitrum, BSC, …), although the Etherscan v2
  `chainid` would make them cheap later.
- Staking, withdrawals from the beacon chain (`txsBeaconWithdrawal`).
- Wallets with more than 10 000 records in one list (the API's result window):
  their sync fails with 502 rather than importing part of the history.
