# Tracking a wallet that already has transactions

**Date:** 2026-09-25
**Status:** Draft, awaiting review
**Scope:** Backend (`updateAccount`, `syncAccount`), the account form and
dialog service. Builds on `2026-09-24-blockchain-sync-design.md`.

## Problem

An account can become blockchain-synced (tracked) only while it is empty
with a zero start balance. That blocks three real cases:

- a wallet migrated from the old app — account #83 "GoMining" holds 136
  hand-categorized payouts ("Interest"), each with its full txid in
  `description` (`tx_hash: 9c05…`); the address has exactly 136 on-chain
  transactions, all incoming, and the sums agree to the satoshi;
- a wallet the user kept by hand and now wants synced;
- a wallet whose tracking was switched off in the account form (it allows
  that) and is being switched back on — meanwhile rows may have been
  edited, deleted or added by hand.

Purging the account first loses every category, description and transfer
peer the user set.

## Goal

Any crypto account can be made tracked. The first sync after that
reconciles the existing rows with the chain: a row that matches an on-chain
transaction is adopted — it keeps its category, description and transfer
peer, and takes the chain's date and amount — and a row that matches
nothing is removed. After the first sync the balance equals the address's.

## Enabling tracking (`services/accounts.ts`, `updateAccount`)

| Transition | Now | New |
|---|---|---|
| untracked → tracked, no transactions | allowed | allowed |
| untracked → tracked, with transactions | 400 | **allowed** |
| tracked → same address and chain | allowed | allowed, seen set kept |
| tracked → other address or chain, with transactions | 400 | 400 |

On untracked → tracked, in the same DB transaction as the account update:

- `chain_seen_txids` of the account is cleared, so the next sync fetches
  the whole history and reconciles;
- `start_balance` is set to 0. A non-zero `startBalance` in the request is
  still rejected by `assertTrackedShape`; a non-zero stored value is reset
  silently.

The currency/scale rule is unchanged: an account holding USD rows cannot
switch to BTC. Switching tracking off is unchanged too — `import_hash`
values and the seen set stay; on re-enable the set is cleared anyway and
rows already carrying chain hashes are recognized by the existing unique
indexes.

## Reconciliation (`services/chainAdopt.ts`)

Runs inside `syncAccount`'s DB transaction, before the `apply` loop, when
the account's seen set is empty (the first sync after enabling). The early
`return` for `txs.length === 0` moves after it: an address with no history
still gets its hand-made rows removed.

### Candidates

Rows with this account on either side whose `import_hash` is null or not in
the set of hashes the sync produces for the fetched plans (`txid`,
`txid:out`, `txid:fee`). This covers hand-entered rows and rows from
statement import, whose `import_hash` is a CSV hash. A row's direction is
`in` when `credit_account_id` is this account, otherwise `out`; its amount
is this account's side (`credit` for `in`, `debit` for `out`).

Rows whose other account is tracked are never adopted — that side is owned
by the other wallet's sync.

### Slots

Only where `apply` inserts a row rather than merging one:

| Slot | From | Direction | Amount | Hash |
|---|---|---|---|---|
| income | `plan.income` with no tracked sender (`peer` undefined) | in | `income.amount` | `txid` |
| expense | `plan.expense` in a plan **without** `transfer` | out | `expense.amount`, or `expense.amount + fee` | `txid` |
| fee | `plan.fee > 0` | out | `fee` | `txid:fee` |

Plans with a transfer between two tracked wallets yield only their fee
slot. A hand row matching such a transaction is removed; the merge logic in
`apply` produces the transfer, and only the row's description is lost.

### Matching (`matchRows(plans, rows)`, pure)

1. **By txid.** A 64-hex-digit txid found in `import_hash` or
   `description` matches the slot of that plan with the same direction.
   For `out`, the fee slot when the row's amount equals the fee, else the
   expense slot. Amounts are not compared — the txid is authoritative.
2. **Heuristic**, over what is left: same direction, amount equal to the
   slot amount (or the expense slot's `amount + fee`), `|date − plan.date|
   ≤ 3 days`. A match counts only when unique both ways: the row fits
   exactly one slot and the slot is fitted by exactly one row.

### Adopting a matched row

- `import_hash` ← the slot's hash; `date` ← the plan's date; this
  account's side ← the slot amount.
- Income / expense: `debit = credit`; category and description kept;
  `payee` kept, or the chain counterparty if it was empty.
- Transfer with an untracked account: stays a transfer, category null; the
  other side takes the slot amount when both accounts share the currency,
  and keeps its amount when they differ.

`apply` then hits the unique index `(account, import_hash)` for these slots
and inserts nothing.

### Removing an unmatched row

- Income / expense: deleted.
- Transfer: left to the other account as Uncategorized income or expense of
  that account's own amount, like `purgeAccountTransactions`.
- Exception: a transfer whose other account is tracked and whose
  `import_hash` is null is deleted outright, so no hand-made row lands on a
  tracked account. (With a hash it is that wallet's synced row, and it
  keeps it.)

### Permissions and failure

Reconciliation changes rows of other accounts, so it requires WRITE on
every account on the other side of a candidate transfer (as `purgeAccount`
does); otherwise 403 `Cannot reconcile: no write access to account <name>`.
Any failure — network, permissions — rolls the whole sync back; the seen
set stays empty and the next sync retries the reconciliation.

### Result

`SyncResult` gains `adopted` (rows matched) and `removed` (deleted plus
left to other accounts).

## Frontend

- **Confirmation** in `AccountForm.onSubmit`: when an existing account
  (`id != null`) had `tracked === false` and `this.tracked()` is now true,
  open `TUI_CONFIRM` before `update`:
  > **Sync from blockchain** — Existing transactions of this account will
  > be reconciled with the blockchain now: matching ones keep their
  > category and description, the rest are removed; transfers to other
  > accounts are left to those accounts. The start balance becomes 0.
  > [Enable sync] [Cancel]

  Cancel keeps the form open and sends nothing. The form does not know the
  transaction count, so the dialog shows for every such transition; the
  wording holds for an empty account too.
- **Auto-sync:** `AccountDialogService.openCreate` and `openEdit` call
  `AccountSyncService.sync(saved)` when the saved account is tracked and
  was not before (a new account counts as not tracked before). This closes
  the window in which the start balance is already 0 but rows are not yet
  reconciled. A failed sync shows the usual `Failed to sync <name>` and can
  be retried with the sync button.
- **Report:** `AccountSyncResult` gains `adopted` and `removed`;
  `describeSync` adds `N transaction(s) matched` and `N removed`, e.g.
  `130 transactions matched, 6 removed, 3 transactions added, 2 fees`.
- Switching tracking off stays unconfirmed — it is now reversible.

## Testing

Test first for each piece.

**`backend/src/test/chainAdopt.test.ts`** (`matchRows`):
- txid in `description` and in `import_hash` matches regardless of amount;
- `out` with a txid goes to the fee slot when the amount equals the fee,
  else to the expense slot;
- heuristic: exact amount within ±3 days; outside the window or a different
  amount → no match; an expense matches `amount + fee`;
- ambiguity: two rows for one slot, or one row fitting two slots → no match;
- tracked-peer transfer plans and income from a tracked sender yield no
  slots except the fee;
- a row with a CSV `import_hash` is a candidate, one with a chain hash is
  not.

**Integration** (DB plus a stub provider, in `chainSync.test.ts` and
`trackedAccounts.test.ts`):
- #83 shape: 136 incoming rows with txids in descriptions →
  `adopted: 136, added: 0`, categories kept, balance unchanged;
- hand wallet: matched expense takes chain amount and date with the user's
  category, fee added separately, unmatched income removed, missing
  transactions added, final balance equals the chain's;
- transfer to an untracked account in another currency stays a transfer
  with the BTC side corrected and the other side unchanged; in the same
  currency both sides take the chain amount;
- an unmatched transfer leaves Uncategorized to the other account; with a
  tracked other account and no hash, the row is deleted;
- no WRITE on the other account → 403, nothing changed, seen set empty;
- empty address → hand rows removed;
- a second sync does not reconcile again;
- `updateAccount`: enabling on an account with transactions is allowed,
  clears seen, zeroes `start_balance`; saving with the same address keeps
  seen; changing the address is still 400;
- disable → delete a synced row → enable → sync: the row is back, other
  categories intact.

**Frontend** (via `ng test`):
- `account-form.spec.ts`: confirm only on untracked → tracked for an
  existing account; Cancel sends no `update`;
- `account-dialog.service.spec.ts`: `sync` is called after creating a
  tracked account and after enabling tracking; not for an untracked account
  or a re-save of a tracked one;
- `account-sync.service.spec.ts`: `describeSync` reports `matched` and
  `removed`.

**Manual:** on a copy of `finance_db_nu`, enable tracking on #83 through
the UI against a temporary backend on `:3001`; expect
`136 transactions matched` and an unchanged balance.

## Out of scope

- Adopting rows that match a transfer between two tracked wallets.
- Changing the address of a tracked account that has transactions.
- A preview of the reconciliation before it runs.
