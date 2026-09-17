# Account Sharing — Design

**Date:** 2026-09-17
**Status:** Approved, ready for implementation planning

## Purpose

Let an account owner grant other users access to an account at one of three
levels. A user then sees, in the application, not only their own accounts and
transactions but also those shared with them.

The immediate driver is data migration: the previous version of this system had
account sharing, and its data cannot be imported without it. Long-term demand
for the feature is unproven, so the design deliberately stays minimal.

## Scope

**In scope (backend only):**

- `account_shares` table and migration
- An access resolver that maps a user to the accounts they can reach
- Rewriting account and transaction queries to filter by accessible accounts
  instead of `user_id`
- Permission checks on account and transaction mutations
- `access_level` and `owner_name` on the account DTO

**Out of scope:**

- Any UI for creating or editing permissions
- Any API endpoint for creating, updating, or revoking permissions — the import
  script writes `account_shares` rows directly via SQL
- Category sharing, merging, or cloning (see Decisions)
- Reports and analytics over shared data

## Key Decisions

### Transactions belong to accounts, not to users

A transaction is visible to a user when they have access to **at least one** of
its accounts. This matches the previous system and matches double-entry
semantics: a transaction is a movement between accounts.

`transactions.user_id` remains in the table as **the author of the record**. It
no longer participates in authorization and must not appear in any `WHERE`
clause that decides visibility.

This is the highest-risk change in the feature. A forgotten `user_id` predicate
does not fail loudly — it silently hides a user's own data or exposes data they
should not see.

### Transfers across access boundaries are fully visible to both sides

When a user transfers from an account shared with them to their own private
account, the owner of the shared account sees the whole transaction, including
the name of the private account on the other side. This is accepted, not a leak
to be patched: the transaction moved both accounts, and hiding either side would
show an incorrect balance.

### No category sharing, merging, or cloning

The previous system merged the owner's and grantee's category trees by full
name, and cloned a category into the grantee's tree when they saved a
transaction under someone else's category. That is three separate mechanisms
(merge on read, resolve on write, parent-chain reconstruction), each with its
own conflict cases.

It is dropped. Its only benefit is complete per-user analytics, and analytics do
not exist in this codebase yet.

Instead:

- The category tree offered for selection is the user's own, plus system
  categories. Unchanged from today.
- A transaction created on a shared account carries the creating user's own
  category.
- When reading someone else's transaction, its category is displayed as stored
  (name and color already arrive via `JOIN`). It is visible but not selectable.
- Filtering by category filters by concrete `category_id`, so another user's
  transactions do not match. This is honest: "show what *I* filed under Food".

Import consequence: categories stay with their owners, and transactions keep
their existing `category_id`. Any categories the old system already cloned
import as ordinary categories of their respective owners.

`canUserAccessCategory`, the category tree, and the frontend are untouched by
this feature.

### Admin cannot delete the account or manage permissions

The previous system's admin level could do everything except transfer
ownership. This design narrows it: level 3 can edit the account, but deleting it
and managing its permissions require ownership.

This is a deliberate narrowing, not an oversight. It was confirmed as
unnecessary for correct import, and it costs one condition rather than a data
migration to widen later.

### Owner is not stored in `account_shares`

`accounts.user_id` stays the single source of ownership. Writing an owner row
into `account_shares` would create a second source of truth that can be deleted,
leaving an account with no owner. The resolver supplies the owner level itself.

## Data Model

Migration `009_create_account_shares.sql`:

```sql
CREATE TABLE account_shares (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  level      INTEGER NOT NULL CHECK (level IN (1, 2, 3)),
  created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (account_id, user_id)
);

CREATE INDEX idx_account_shares_user_id ON account_shares(user_id);
```

- **Composite primary key** — a user cannot hold two levels on one account, and
  the database enforces it rather than the service.
- **`ON DELETE CASCADE` on account** — hard-deleting an account removes its
  grants. This differs from the `RESTRICT` on transaction foreign keys, and
  intentionally so: permissions are not history.
- **`level` as an integer** — 1 = read, 2 = transactions, 3 = admin. The import
  data carries numbers. Named constants live in TypeScript, not in the schema.
- **Index on `user_id`** — every request asks "which accounts can this user
  reach".

## Access Resolver

New module `backend/src/services/access.ts`. The only place that knows about
levels.

```ts
export const LEVEL = { READ: 1, WRITE: 2, ADMIN: 3, OWNER: 4 } as const;
export type AccessLevel = 1 | 2 | 3 | 4;

// accountId -> level, including the user's own accounts at OWNER
export async function getAccessMap(userId: number): Promise<Map<number, AccessLevel>>;

// Level on one account, or null when there is no access
export async function getAccountLevel(accountId: number, userId: number): Promise<AccessLevel | null>;

// Throws { statusCode: 403 } when the level is below `min`
export async function requireLevel(accountId: number, userId: number, min: AccessLevel): Promise<void>;
```

`getAccessMap` is a single query:

```sql
SELECT id AS account_id, 4 AS level FROM accounts WHERE user_id = $1
UNION ALL
SELECT account_id, level FROM account_shares WHERE user_id = $1
```

`OWNER = 4` sits above the three stored levels so every check is a plain
`level >= required`, and "admin but not owner" is `level >= 3` versus
`level === OWNER` with no special cases.

Permission checks are called **only from the service layer** — not from queries,
not from routes. The services already work this way: `loadAccount` and
`validateCategory` throw 403 today.

### Permission table

| Action | Required level |
|---|---|
| See an account and its balance | ≥ 1 |
| See an account's transactions | ≥ 1 |
| Create / update / delete a transaction touching an account | ≥ 2 on **every** account it touches |
| Update the account itself (`PUT`) | ≥ 3 |
| Delete the account (`DELETE`) | OWNER |
| Manage permissions | OWNER (no API yet) |

**"Every account it touches"** — a transfer between accounts A and B requires
level ≥ 2 on both. Otherwise a user with write access to A could move money onto
a third party's account B while holding only read access to B. On update, both
the transaction's **current** accounts and its **new** accounts are checked;
without that, a transaction could be moved off an account the user cannot write
to.

**Deleting a transaction** requires ≥ 2 on its accounts, not OWNER. This follows
from the definition of level 2.

## Query and Service Changes

Every place `user_id` currently acts as an ownership filter.

### `db/queries/accounts.ts`

- `getAccountsByUserId(userId)` → `getAccountsByIds(accountIds)`, filtering
  `WHERE id = ANY($1)`.
- `getAccountById(id, userId)` → `getAccountById(id)`. The service checks
  access, which also lets it distinguish "no such account" (404) from "no
  access" (403).
- `updateAccount`, `softDeleteAccount`, `hardDeleteAccount` — drop
  `AND user_id = $n`. Permissions are already checked in the service. Leaving
  the predicate in place would be actively harmful: for a non-owner admin it is
  false, and the update would silently affect zero rows.

### `db/queries/transactions.ts`

The riskiest file.

- `getTransactionsByUserId(userId, filters)` → `getTransactions(accountIds, filters)`.
  The `t.user_id = $1` condition becomes
  `(t.debit_account_id = ANY($1) OR t.credit_account_id = ANY($1))`.
- `getTransactionDTOById`, `getTransactionById` — look up by id; the service
  checks access.
- `createTransaction(userId, data)` — `userId` **stays**, now recording the
  author rather than filtering.
- `updateTransaction`, `deleteTransaction` — drop `AND user_id = $n`.
- `getBalancesAt` — drop `t.user_id = $1` from the `JOIN` and `a.user_id = $1`
  from the `WHERE`. The `accountIds` filter remains, already narrowed by the
  service.
- `getAccountBalances` — drop `WHERE user_id = $1`; filter by accounts only.

**`getAccountBalances` empty-array behavior must change.** Today an empty
`accountIds` means "all of this user's transactions" via the
`array_length(...) IS NULL OR ...` branch. With `user_id` gone that branch
becomes "all transactions in the database". The branch is removed: an empty list
means no results, and callers always pass an explicit list.

### `services/accounts.ts`

- `getAccounts` — resolver → `getAccountsByIds`. Accounts in the response carry
  `access_level` and `owner_name`.
- `updateAccount` — `requireLevel(id, userId, ADMIN)`.
- `deleteAccount` — `requireLevel(id, userId, OWNER)`.
- `withBalances` / `withConvertedBalances` — lose `userId` where it was a
  filter. Conversion to the user's display currency still uses the **requesting**
  user's currency, not the owner's.

### `services/transactions.ts`

- `getTransactions` — resolver → accessible ids → query. When the `account`
  filter is supplied it is **intersected** with the accessible set rather than
  trusted.
- `loadAccount` — `getAccountById(id)` plus `requireLevel(..., WRITE)`.
- `updateTransaction` — check WRITE on the transaction's existing accounts and
  on the new ones.
- `deleteTransaction` — check WRITE on the transaction's accounts.
- `attachRunningBalances` — receives accessible account ids instead of `userId`.

### `types/index.ts`

`Account` gains `access_level: AccessLevel` and `owner_name: string`.
`owner_name` is populated for owned accounts too — uniformity is cheaper than a
conditional branch in the frontend.

### Frontend

Only the `Account` type gains the two new fields. No sharing UI. Hiding edit
controls on accounts the user cannot modify is deliberately deferred to the
sharing UI task; until then the backend returns 403.

## Revocation Behavior

Revoking access is a plain `DELETE FROM account_shares`. No code is required.
What it does and does not do:

1. **Transactions created by the revoked user remain.** `transactions.user_id`
   still points at them and the account still belongs to the owner. History is
   not rewritten on revocation.
2. **Cross-boundary transfers stay visible to both sides.** A transfer between
   the shared account and the revoked user's private account remains visible to
   the owner through their side and to the revoked user through theirs.
   Revocation does not sever transactions that already exist. This follows
   directly from "visible when at least one account is accessible".
3. **Grants on a deleted account disappear** via `ON DELETE CASCADE`.
4. **Revocation takes effect immediately.** The resolver reads the database on
   every request; permissions are never cached in the JWT.

An account can become undeletable because of a revoked user's transactions: a
non-zero balance yields 409 from `deleteAccount`. This is existing behavior that
sharing merely makes more likely, and it is left unchanged — "non-zero balance
blocks deletion" is equally true regardless of who created the transactions.

## Open Questions (deferred)

To revisit when permission-management UI is built:

- Should revocation offer to reassign or delete the revoked user's
  transactions, rather than leaving them in place?
- Should a user be able to see *which* users an account is shared with, and at
  what level, without being the owner?
- Widen admin (level 3) to include deleting the account and granting access, as
  the previous system had it?
- Ownership transfer.
- Should cross-boundary transfers be restricted or the counterparty account name
  masked, if the full visibility proves uncomfortable in practice?

## Testing

Backend Jest tests. Existing tests must pass **unchanged** — the owner resolves
to `OWNER` and single-user behavior is identical. A regression in the
single-user path means the resolver is wrong.

New file `backend/src/test/sharing.test.ts`. Fixture: user A owns account `A1`
(and `A2`), user B owns private account `B1`; grants on `A1` to B vary by test.

**Resolver** — owner resolves to OWNER; a grant resolves to its stored level; a
missing row means no access; deleting the row removes access immediately.

**Visibility (level 1)** — B sees `A1` in `GET /accounts` with `access_level: 1`
and `owner_name`; B sees `A1`'s transactions in `GET /transactions`; the balance
B sees for `A1` equals the balance A sees; B does not see `A2`.

**Level boundaries**, cell by cell against the permission table — level 1:
transaction POST/PUT/DELETE all 403; level 2: transactions succeed, account PUT
403; level 3: account PUT succeeds, account DELETE 403; owner: everything
succeeds.

**Cross-boundary transfer** — B (level 2 on `A1`) transfers `A1 → B1`. The
transaction is created; A sees it in full including `B1`; B sees it too. Then
with level 1 on `A1` the same transfer returns 403, exercising "≥ 2 on every
account" from the under-privileged side.

**Update across a boundary** — B (level 2 on `A1`) tries to move an existing
transaction onto `A2`, which they cannot reach → 403. This covers checking both
old and new accounts.

**Revocation** — after deleting the grant: `A1` disappears from B's account
list and `A1`'s transactions disappear from B's transaction list; but the
`A1 ↔ B1` transfer stays visible to B through `B1`, and stays fully visible
to A.

**Balances** — the two rewritten aggregate queries need direct coverage: the
running balance B sees on a shared account matches what A sees, and an empty
accessible-account list yields an empty result rather than every transaction in
the database.

## Implementation Order

TDD, per project convention:

1. Migration and resolver, with resolver tests.
2. Rewrite queries to filter by accessible accounts; visibility tests go green.
3. Permission checks on mutations; level-boundary tests go green.
4. `access_level` / `owner_name` in the DTO and the frontend type.

## Success Criteria

- Every existing backend test passes without modification.
- No `user_id` predicate remains in any account or transaction query that
  decides visibility; `transactions.user_id` is written on create and read back
  as the author only.
- The permission table is enforced cell for cell, verified by test.
- `getAccountBalances` with an empty account list returns nothing.
