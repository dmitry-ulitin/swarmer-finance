# Account Sharing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an account owner grant other users read / write / admin access to an account, so a user sees both their own accounts and transactions and those shared with them.

**Architecture:** A new `account_shares` table plus a single access resolver (`services/access.ts`) that maps a user to `accountId → level`. Account and transaction queries stop filtering by `user_id` and filter by the resolved set of accessible account ids instead; services enforce per-level permissions before mutating. `transactions.user_id` is kept as the record's author but is removed from every authorization path.

**Tech Stack:** Node.js, Express 5, TypeScript, raw SQL over `pg`, Jest + supertest, Angular 22 frontend (type-only change).

**Spec:** `docs/superpowers/specs/2026-09-17-account-sharing-design.md`

## Global Constraints

- Levels are integers: `1` = read, `2` = write (transactions), `3` = admin. `OWNER = 4` exists only in TypeScript, never in the database.
- Ownership lives solely in `accounts.user_id`. Never insert an owner row into `account_shares`.
- `transactions.user_id` is written on create and read back as the author. It must not appear in any `WHERE` clause that decides visibility.
- Permission checks live in the **service layer only** — never in `db/queries/*`, never in routes.
- All API responses keep the envelope `{ data: T | null, error: string | null }`.
- Errors are thrown as `{ statusCode, message }` objects, matching the existing services.
- Tests run against a real Postgres with `maxWorkers: 1`. `src/test/setup.ts` wipes `users`, `categories`, and `transactions` in a global `beforeAll` — never rely on data created outside your own suite's `beforeAll`.
- No API endpoint for managing permissions. The import script writes `account_shares` directly via SQL.
- No sharing UI. The frontend change is the `Account` type only.

## File Structure

**Create:**
- `backend/src/db/migrations/009_create_account_shares.sql` — the table.
- `backend/src/db/queries/accountShares.ts` — the two SQL reads the resolver needs. Separate file so sharing SQL does not get mixed into `accounts.ts`.
- `backend/src/services/access.ts` — levels, resolver, `requireLevel`. The only module that knows what a level means.
- `backend/src/test/access.test.ts` — unit tests for the resolver.
- `backend/src/test/sharing.test.ts` — end-to-end permission and visibility tests.

**Modify:**
- `backend/src/db/queries/accounts.ts` — drop `user_id` filters, add `getAccountsByIds`, join owner name.
- `backend/src/db/queries/transactions.ts` — filter by account ids instead of `user_id`.
- `backend/src/services/accounts.ts` — resolve access, enforce ADMIN / OWNER.
- `backend/src/services/transactions.ts` — resolve access, enforce WRITE on every touched account.
- `backend/src/types/index.ts` — `Account.access_level`, `Account.owner_name`.
- `frontend/src/app/models/account.ts` — the same two fields, optional.

**Note (do not act on):** `services/transactions.ts` exports a `getAccountBalances` wrapper (line ~226) that no route or other module calls — pre-existing dead code. Task 5 changes its signature to keep it compiling; removing it is out of scope.

---

### Task 1: The `account_shares` table

**Files:**
- Create: `backend/src/db/migrations/009_create_account_shares.sql`
- Test: verified by running the migration (no test file — this task adds schema only)

**Interfaces:**
- Consumes: nothing.
- Produces: table `account_shares(account_id, user_id, level, created_at)` with PK `(account_id, user_id)`.

- [ ] **Step 1: Write the migration**

Create `backend/src/db/migrations/009_create_account_shares.sql`:

```sql
-- Per-account access grants. The owner is NOT stored here: accounts.user_id
-- remains the single source of ownership, and services/access.ts supplies the
-- owner level itself. Storing an owner row would create a second source of
-- truth that can be deleted, leaving an account with no owner.
CREATE TABLE IF NOT EXISTS account_shares (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  level      INTEGER NOT NULL CHECK (level IN (1, 2, 3)),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (account_id, user_id)
);

-- Every request asks "which accounts can this user reach".
CREATE INDEX IF NOT EXISTS idx_account_shares_user_id ON account_shares(user_id);
```

`ON DELETE CASCADE` on `account_id` is deliberate and differs from the `RESTRICT` used on transaction foreign keys: permissions are not history, so hard-deleting an account should take its grants with it.

- [ ] **Step 2: Run the migration**

Run: `cd backend && npm run migrate`
Expected: output contains `Running migration: 009_create_account_shares.sql` then `Completed: 009_create_account_shares.sql`.

- [ ] **Step 3: Verify the table exists and rejects a bad level**

Run:

```bash
cd backend && psql "$DATABASE_URL" -c "INSERT INTO account_shares (account_id, user_id, level) VALUES (999999, 999999, 9);"
```

Expected: FAIL. Either a foreign-key violation (`account_shares_account_id_fkey`) or the check constraint — both prove the table is present with constraints attached. No row is inserted.

- [ ] **Step 4: Commit**

```bash
git add backend/src/db/migrations/009_create_account_shares.sql
git commit -m "feat(sharing): add account_shares table"
```

---

### Task 2: Access resolver

**Files:**
- Create: `backend/src/db/queries/accountShares.ts`
- Create: `backend/src/services/access.ts`
- Test: `backend/src/test/access.test.ts`

**Interfaces:**
- Consumes: the `account_shares` table from Task 1.
- Produces:
  - `LEVEL = { READ: 1, WRITE: 2, ADMIN: 3, OWNER: 4 }` and `type AccessLevel = 1 | 2 | 3 | 4` from `services/access.ts`
  - `getAccessMap(userId: number): Promise<Map<number, AccessLevel>>`
  - `getAccessibleAccountIds(userId: number): Promise<number[]>`
  - `getAccountLevel(accountId: number, userId: number): Promise<AccessLevel | null>`
  - `requireLevel(accountId: number, userId: number, min: AccessLevel): Promise<void>`
  - `requireLevelOnAll(accountIds: (number | null | undefined)[], userId: number, min: AccessLevel): Promise<void>`

- [ ] **Step 1: Write the failing test**

Create `backend/src/test/access.test.ts`:

```ts
import { pool } from '../db';
import { LEVEL, getAccessMap, getAccessibleAccountIds, getAccountLevel, requireLevel } from '../services/access';

describe('access resolver', () => {
  let ownerId: number;
  let granteeId: number;
  let strangerId: number;
  let ownedAccountId: number;
  let otherAccountId: number;

  beforeAll(async () => {
    const mk = async (email: string) => {
      const r = await pool.query(
        `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
        [email]
      );
      return r.rows[0].id as number;
    };
    const stamp = Date.now();
    ownerId = await mk(`owner${stamp}@example.com`);
    granteeId = await mk(`grantee${stamp}@example.com`);
    strangerId = await mk(`stranger${stamp}@example.com`);

    const acc = await pool.query(
      `INSERT INTO accounts (user_id, name, currency, start_balance, scale)
       VALUES ($1, 'Owned', 'USD', 0, 2) RETURNING id`,
      [ownerId]
    );
    ownedAccountId = acc.rows[0].id;

    const other = await pool.query(
      `INSERT INTO accounts (user_id, name, currency, start_balance, scale)
       VALUES ($1, 'Other', 'USD', 0, 2) RETURNING id`,
      [ownerId]
    );
    otherAccountId = other.rows[0].id;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM account_shares WHERE account_id = ANY($1::int[])', [[ownedAccountId, otherAccountId]]);
    await pool.query('DELETE FROM accounts WHERE user_id = $1', [ownerId]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [[ownerId, granteeId, strangerId]]);
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM account_shares WHERE account_id = ANY($1::int[])', [[ownedAccountId, otherAccountId]]);
  });

  it('resolves the owner to OWNER on their own accounts', async () => {
    const map = await getAccessMap(ownerId);
    expect(map.get(ownedAccountId)).toBe(LEVEL.OWNER);
    expect(map.get(otherAccountId)).toBe(LEVEL.OWNER);
  });

  it('resolves a grant to its stored level', async () => {
    await pool.query(
      'INSERT INTO account_shares (account_id, user_id, level) VALUES ($1, $2, $3)',
      [ownedAccountId, granteeId, LEVEL.WRITE]
    );
    const map = await getAccessMap(granteeId);
    expect(map.get(ownedAccountId)).toBe(LEVEL.WRITE);
  });

  it('gives no access without a grant', async () => {
    const map = await getAccessMap(strangerId);
    expect(map.size).toBe(0);
    expect(await getAccountLevel(ownedAccountId, strangerId)).toBeNull();
  });

  it('does not leak accounts that were not granted', async () => {
    await pool.query(
      'INSERT INTO account_shares (account_id, user_id, level) VALUES ($1, $2, $3)',
      [ownedAccountId, granteeId, LEVEL.READ]
    );
    const ids = await getAccessibleAccountIds(granteeId);
    expect(ids).toContain(ownedAccountId);
    expect(ids).not.toContain(otherAccountId);
  });

  it('drops access immediately when the grant row is deleted', async () => {
    await pool.query(
      'INSERT INTO account_shares (account_id, user_id, level) VALUES ($1, $2, $3)',
      [ownedAccountId, granteeId, LEVEL.ADMIN]
    );
    expect(await getAccountLevel(ownedAccountId, granteeId)).toBe(LEVEL.ADMIN);

    await pool.query('DELETE FROM account_shares WHERE account_id = $1 AND user_id = $2', [ownedAccountId, granteeId]);
    expect(await getAccountLevel(ownedAccountId, granteeId)).toBeNull();
  });

  it('requireLevel passes at or above the minimum and throws 403 below it', async () => {
    await pool.query(
      'INSERT INTO account_shares (account_id, user_id, level) VALUES ($1, $2, $3)',
      [ownedAccountId, granteeId, LEVEL.WRITE]
    );

    await expect(requireLevel(ownedAccountId, granteeId, LEVEL.READ)).resolves.toBeUndefined();
    await expect(requireLevel(ownedAccountId, granteeId, LEVEL.WRITE)).resolves.toBeUndefined();
    await expect(requireLevel(ownedAccountId, granteeId, LEVEL.ADMIN)).rejects.toMatchObject({ statusCode: 403 });
    await expect(requireLevel(ownedAccountId, ownerId, LEVEL.OWNER)).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && npx jest --testPathPatterns=access`
Expected: FAIL — `Cannot find module '../services/access'`.

- [ ] **Step 3: Write the share queries**

Create `backend/src/db/queries/accountShares.ts`:

```ts
import { query } from '../index';

export interface AccessRow {
  account_id: number;
  level: number;
}

/**
 * Every account the user can reach, with the level they hold on it.
 *
 * Owned accounts are reported at level 4 (OWNER in services/access.ts),
 * above the three levels that account_shares can store, so all permission
 * checks reduce to `level >= required`.
 */
export const getAccessRows = async (userId: number): Promise<AccessRow[]> => {
  return query<AccessRow>(
    `SELECT id AS account_id, 4 AS level FROM accounts WHERE user_id = $1
     UNION ALL
     SELECT account_id, level FROM account_shares WHERE user_id = $1`,
    [userId]
  );
};
```

- [ ] **Step 4: Write the resolver**

Create `backend/src/services/access.ts`:

```ts
import { getAccessRows } from '../db/queries/accountShares';

/**
 * Access levels. 1-3 are stored in account_shares; OWNER is synthesised by
 * the resolver for accounts the user owns, so every check is a plain
 * `level >= required` and "admin but not owner" is `level === LEVEL.OWNER`
 * without a special case.
 */
export const LEVEL = { READ: 1, WRITE: 2, ADMIN: 3, OWNER: 4 } as const;
export type AccessLevel = 1 | 2 | 3 | 4;

/** accountId -> level, including owned accounts at OWNER. */
export const getAccessMap = async (userId: number): Promise<Map<number, AccessLevel>> => {
  const rows = await getAccessRows(userId);
  const map = new Map<number, AccessLevel>();
  for (const row of rows) {
    const level = row.level as AccessLevel;
    const existing = map.get(row.account_id);
    // An owner could also hold a stale share row on their own account;
    // the strongest level wins.
    if (existing === undefined || level > existing) {
      map.set(row.account_id, level);
    }
  }
  return map;
};

export const getAccessibleAccountIds = async (userId: number): Promise<number[]> => {
  return [...(await getAccessMap(userId)).keys()];
};

export const getAccountLevel = async (
  accountId: number,
  userId: number
): Promise<AccessLevel | null> => {
  const map = await getAccessMap(userId);
  return map.get(accountId) ?? null;
};

/** Throws 403 when the user's level on the account is below `min`. */
export const requireLevel = async (
  accountId: number,
  userId: number,
  min: AccessLevel
): Promise<void> => {
  const level = await getAccountLevel(accountId, userId);
  if (level === null || level < min) {
    throw { statusCode: 403, message: 'Insufficient permissions for this account' };
  }
};

/**
 * Requires `min` on every account id given, ignoring null/undefined entries.
 *
 * Used for transactions: a transfer touches two accounts, and write access to
 * one of them must not be enough to move money against the other.
 */
export const requireLevelOnAll = async (
  accountIds: (number | null | undefined)[],
  userId: number,
  min: AccessLevel
): Promise<void> => {
  const ids = [...new Set(accountIds.filter((id): id is number => id != null))];
  for (const id of ids) {
    await requireLevel(id, userId, min);
  }
};
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd backend && npx jest --testPathPatterns=access`
Expected: PASS — 6 tests.

- [ ] **Step 6: Commit**

```bash
git add backend/src/db/queries/accountShares.ts backend/src/services/access.ts backend/src/test/access.test.ts
git commit -m "feat(sharing): add access level resolver"
```

---

### Task 3: Account queries filter by id, not owner

**Files:**
- Modify: `backend/src/db/queries/accounts.ts`
- Modify: `backend/src/types/index.ts`
- Test: covered by the existing `backend/src/test/accounts.test.ts` (must stay green) and by Task 6

**Interfaces:**
- Consumes: nothing from Task 2 — this task is pure query surgery.
- Produces:
  - `getAccountsByIds(accountIds: number[]): Promise<Account[]>`
  - `getAccountById(id: number): Promise<Account | null>` — **one argument now**
  - `updateAccount(id, data)`, `softDeleteAccount(id)`, `hardDeleteAccount(id)` — **no `userId`**
  - `Account.access_level?: AccessLevel`, `Account.owner_name?: string`

- [ ] **Step 1: Add the new fields to the Account type**

In `backend/src/types/index.ts`, add to `interface Account` (after `settings`):

```ts
  /** The requesting user's level on this account; set by services/accounts.ts. */
  access_level?: 1 | 2 | 3 | 4;
  /** Display name of the account's owner; set by the accounts query. */
  owner_name?: string;
```

They are optional because `db/queries/accounts.ts` builds `Account` rows that do not carry `access_level` until the service attaches it.

- [ ] **Step 2: Replace the read queries**

In `backend/src/db/queries/accounts.ts`, replace `getAccountsByUserId` and `getAccountById` with:

```ts
export const getAccountsByIds = async (accountIds: number[]): Promise<Account[]> => {
  if (accountIds.length === 0) return [];
  return query<Account>(
    `SELECT a.*, u.name AS owner_name
     FROM accounts a
     JOIN users u ON u.id = a.user_id
     WHERE a.id = ANY($1::int[])
     ORDER BY a.name`,
    [accountIds]
  );
};

// Access is checked by the service layer, so this looks up by id alone.
// That also lets the service tell "no such account" (404) apart from
// "no access" (403).
export const getAccountById = async (id: number): Promise<Account | null> => {
  return queryOne<Account>(
    `SELECT a.*, u.name AS owner_name
     FROM accounts a
     JOIN users u ON u.id = a.user_id
     WHERE a.id = $1`,
    [id]
  );
};
```

- [ ] **Step 3: Drop `user_id` from the write queries**

In the same file, change the three mutating queries. `updateAccount` loses its `userId` parameter and its predicate:

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
  }
): Promise<Account | null> => {
  // `type` and `settings` are written unconditionally, not COALESCEd:
  // changing an account's type must drop the previous type's fields.
  //
  // No user_id predicate: permission is checked in services/accounts.ts.
  // Keeping one here would be worse than redundant — for an admin who is
  // not the owner it is false, and the update would silently affect no rows.
  const result = await query<Account>(
    `UPDATE accounts
     SET name = COALESCE($1, name),
         currency = COALESCE($2, currency),
         start_balance = COALESCE($3, start_balance),
         scale = COALESCE($4, scale),
         type = $5,
         settings = $6
     WHERE id = $7 AND deleted = false RETURNING *`,
    [
      data.name ?? null,
      data.currency ?? null,
      data.startBalance ?? null,
      data.scale ?? null,
      data.type,
      JSON.stringify(data.settings),
      id,
    ]
  );
  return result[0] || null;
};
```

And the two deletes:

```ts
export const softDeleteAccount = async (id: number): Promise<boolean> => {
  const count = await execute(
    'UPDATE accounts SET deleted = true WHERE id = $1 AND deleted = false',
    [id]
  );
  return count > 0;
};

export const hardDeleteAccount = async (id: number): Promise<boolean> => {
  const count = await execute(
    'DELETE FROM accounts WHERE id = $1 AND deleted = false',
    [id]
  );
  return count > 0;
};
```

`hasTransactions` is unchanged — it never took a `userId`.

- [ ] **Step 3b: Drop `userId` from `getAccountBalances`**

`services/accounts.ts` calls this one query from `db/queries/transactions.ts`, so its signature has to change together with the account queries — otherwise Task 4 leaves a type error, and `ts-jest` runs with diagnostics on, which would fail that task's test run rather than merely `tsc`.

In `backend/src/db/queries/transactions.ts`, replace `getAccountBalances` with:

```ts
export const getAccountBalances = async (
  accountIds: number[]
): Promise<AccountBalance[]> => {
  // An empty list means no accounts, so no balances. The previous
  // `array_length(...) IS NULL` branch meant "all of this user's
  // transactions"; with user_id gone it would mean every transaction in the
  // database, so it is removed and callers always pass an explicit list.
  if (accountIds.length === 0) return [];
  const rows = await query<Omit<AccountBalance, 'debit' | 'credit'> & { debit: string; credit: string }>(
    `SELECT
       debit_account_id,
       credit_account_id,
       SUM(debit) AS debit,
       SUM(credit) AS credit,
       MAX(date) AS last_date
     FROM transactions
     WHERE debit_account_id = ANY($1::int[])
        OR credit_account_id = ANY($1::int[])
     GROUP BY debit_account_id, credit_account_id
     ORDER BY last_date DESC`,
    [accountIds]
  );
  return rows.map(row => ({ ...row, debit: Number(row.debit), credit: Number(row.credit) }));
};
```

Also update the thin wrapper at the bottom of `backend/src/services/transactions.ts` so it keeps compiling (it has no callers — pre-existing dead code, left in place deliberately):

```ts
export const getAccountBalances = async (
  accountIds: number[]
): Promise<transactionQueries.AccountBalance[]> => {
  return transactionQueries.getAccountBalances(accountIds);
};
```

- [ ] **Step 4: Verify it does not compile yet**

Run: `cd backend && npx tsc --noEmit`
Expected: FAIL with errors in `src/services/accounts.ts` and `src/services/transactions.ts` — calls still pass `userId` to `getAccountById`, `updateAccount`, `softDeleteAccount`, `hardDeleteAccount`, `getAccountBalances`, and call the now-removed `getAccountsByUserId`. Task 4 and Task 5 fix these. This failure is the checklist of call sites to update.

- [ ] **Step 5: Commit**

```bash
git add backend/src/db/queries/accounts.ts backend/src/db/queries/transactions.ts backend/src/services/transactions.ts backend/src/types/index.ts
git commit -m "refactor(sharing): filter account queries by id instead of user_id"
```

Committing a non-compiling tree is intentional here: the queries and their callers are two reviewable units, and Task 4 immediately restores the build.

---

### Task 4: Accounts service resolves access and enforces levels

**Files:**
- Modify: `backend/src/services/accounts.ts`
- Test: existing `backend/src/test/accounts.test.ts` must pass unchanged

**Interfaces:**
- Consumes: `getAccessMap`, `getAccessibleAccountIds`, `requireLevel`, `LEVEL`, `AccessLevel` (Task 2); `getAccountsByIds`, `getAccountById(id)`, `updateAccount(id, data)`, `softDeleteAccount(id)`, `hardDeleteAccount(id)` (Task 3).
- Produces: `getAccounts` returns accounts carrying `access_level` and `owner_name`; `updateAccount` requires ADMIN; `deleteAccount` requires OWNER.

- [ ] **Step 1: Update the imports and `withBalances`**

In `backend/src/services/accounts.ts`, add to the imports:

```ts
import { LEVEL, AccessLevel, getAccessMap, getAccessibleAccountIds, requireLevel } from './access';
```

`withBalances` no longer needs a user — it sums transactions for the accounts it is given:

```ts
async function withBalances(accounts: Account[]): Promise<Account[]> {
  const rows = await getAccountBalances(accounts.map(a => a.id));
  return accounts.map(account => {
    let balance = Number(account.start_balance);
    for (const row of rows) {
      if (row.credit_account_id === account.id) balance += row.credit;
      if (row.debit_account_id === account.id) balance -= row.debit;
    }
    return { ...account, balance };
  });
}
```

(`getAccountBalances` loses its `userId` parameter in Task 5. Until then `tsc` reports that one call — expected.)

- [ ] **Step 2: Rewrite `getAccounts`**

```ts
export const getAccounts = async (userId: number) => {
  const user = await getUserOrThrow(userId);
  const accessMap = await getAccessMap(userId);
  const accounts = await accountQueries.getAccountsByIds([...accessMap.keys()]);
  const withLevel = accounts.map(a => ({ ...a, access_level: accessMap.get(a.id)! }));
  const withBal = await withBalances(withLevel);
  const converted = await withConvertedBalances(user, withBal);
  return converted.map(a => toDecimalDTO(a, user.currency_scale));
};
```

`withConvertedBalances` still converts to the **requesting** user's currency, not the owner's — a shared account is displayed in the currency of whoever is looking.

- [ ] **Step 3: Enforce ADMIN on update and OWNER on delete**

In `updateAccount`, replace the ownership lookup:

```ts
  const existing = await accountQueries.getAccountById(id);
  if (!existing) {
    throw { statusCode: 404, message: 'Account not found' };
  }
  await requireLevel(id, userId, LEVEL.ADMIN);
  if (existing.deleted) {
    throw { statusCode: 404, message: 'Account is deleted' };
  }
```

and its write call, which no longer takes `userId`:

```ts
  const account = await accountQueries.updateAccount(id, { ...data, startBalance });
  const [withBal] = await withBalances([account!]);
```

In `deleteAccount`, do the same with OWNER:

```ts
  const existing = await accountQueries.getAccountById(id);
  if (!existing) {
    throw { statusCode: 404, message: 'Account not found' };
  }
  await requireLevel(id, userId, LEVEL.OWNER);
  if (existing.deleted) {
    throw { statusCode: 404, message: 'Account is deleted' };
  }
```

then drop `userId` from the three calls inside it:

```ts
    const ok = await accountQueries.hardDeleteAccount(id);
```

```ts
  const [accountWithBalance] = await withBalances([existing]);
```

```ts
  const ok = await accountQueries.softDeleteAccount(id);
```

The 404-before-403 order is deliberate: a user with no access to a nonexistent account still gets 404, which matches the existing tests.

- [ ] **Step 4: Update the doc comment on `deleteAccount`**

The existing block comment above `deleteAccount` documents the 3-state delete policy. Add one line to its end, before the closing `*/`:

```
 * Deleting requires OWNER: an admin-level grantee can edit the account but
 * not destroy it (see docs/superpowers/specs/2026-09-17-account-sharing-design.md).
```

- [ ] **Step 5: Run the account tests**

Run: `cd backend && npx jest --testPathPatterns=accounts`
Expected: PASS, unchanged. If any *account* test fails, the resolver is wrong — single-user behavior must be identical.

`ts-jest` runs with diagnostics enabled (there is no `diagnostics: false` in `jest.config.js`), so a type error anywhere in this file's import graph fails the run outright. `getAccountBalances` was already given its single-argument signature in Task 3 Step 3b, so this file type-checks cleanly now.

- [ ] **Step 6: Commit**

```bash
git add backend/src/services/accounts.ts
git commit -m "feat(sharing): resolve access in accounts service, require ADMIN to edit and OWNER to delete"
```

---

### Task 5: Transaction queries and service filter by accessible accounts

**Files:**
- Modify: `backend/src/db/queries/transactions.ts`
- Modify: `backend/src/services/transactions.ts`
- Test: existing `backend/src/test/transactions.test.ts` must pass unchanged

**Interfaces:**
- Consumes: `LEVEL`, `getAccessibleAccountIds`, `requireLevelOnAll` (Task 2); `getAccountById(id)` (Task 3).
- Produces:
  - `getTransactions(accountIds: number[], filters: TransactionFilters): Promise<TransactionDTO[]>`
  - `getTransactionDTOById(id: number)`, `getTransactionById(id: number)` — one argument
  - `updateTransaction(id, data)`, `deleteTransaction(id)` — no `userId`
  - `getBalancesAt(accountIds, date, createdAt, id)`, `getAccountBalances(accountIds)` — no `userId`

This is the riskiest task in the plan: a forgotten `user_id` predicate does not fail loudly, it silently hides or exposes data.

- [ ] **Step 1: Rewrite the transaction read queries**

In `backend/src/db/queries/transactions.ts`:

```ts
export const getTransactionDTOById = async (id: number): Promise<TransactionDTO | null> => {
  const row = await queryOne<TransactionRow>(
    `${WITH_DETAILS_SQL} WHERE t.id = $1`,
    [id]
  );
  return row ? toDTO(row) : null;
};

export const getTransactionById = async (id: number): Promise<Transaction | null> => {
  return queryOne<Transaction>('SELECT * FROM transactions WHERE id = $1', [id]);
};
```

Rename `getTransactionsByUserId` to `getTransactions` and swap the ownership predicate for an account predicate. Only the first three lines of the body change; the rest of the filter building is untouched:

```ts
export const getTransactions = async (
  accountIds: number[],
  filters: TransactionFilters
): Promise<TransactionDTO[]> => {
  if (accountIds.length === 0) return [];

  // A transaction is visible when the user can reach at least one of its
  // accounts. t.user_id records who entered it and is NOT an access filter.
  const conditions: string[] = [
    '(t.debit_account_id = ANY($1::int[]) OR t.credit_account_id = ANY($1::int[]))',
  ];
  const params: unknown[] = [accountIds];
  let paramIndex = 2;
```

Everything from `if (filters.from) {` to the end of the function stays exactly as it is.

- [ ] **Step 2: Drop `user_id` from create/update/delete**

`createTransaction` keeps `userId` — it is the author — but its final read no longer passes one:

```ts
  return (await getTransactionDTOById(result[0].id))!;
```

`updateTransaction` drops the parameter and the predicate:

```ts
export const updateTransaction = async (
  id: number,
  data: UpdateTransactionData
): Promise<TransactionDTO | null> => {
  const count = await execute(
    `UPDATE transactions
     SET category_id = $1,
         debit_account_id = $2,
         credit_account_id = $3,
         debit = $4,
         credit = $5,
         date = $6,
         description = $7,
         payee = $8
     WHERE id = $9`,
    [
      data.categoryId ?? null,
      data.debitAccountId ?? null,
      data.creditAccountId ?? null,
      data.debit ?? null,
      data.credit ?? null,
      data.date ?? null,
      data.description ?? null,
      data.payee ?? null,
      id,
    ]
  );
  if (count === 0) return null;
  return getTransactionDTOById(id);
};

export const deleteTransaction = async (id: number): Promise<boolean> => {
  const count = await execute('DELETE FROM transactions WHERE id = $1', [id]);
  return count > 0;
};
```

- [ ] **Step 3: Rewrite the two balance queries**

`getBalancesAt` loses `userId` from both the JOIN and the WHERE:

```ts
export const getBalancesAt = async (
  accountIds: number[],
  date: string,
  createdAt: Date,
  id: number
): Promise<AccountBalanceAt[]> => {
  if (accountIds.length === 0) return [];
  const rows = await query<{ id: number; balance: string }>(
    `SELECT a.id,
            (a.start_balance
             + COALESCE(SUM(t.credit) FILTER (WHERE t.credit_account_id = a.id), 0)
             - COALESCE(SUM(t.debit)  FILTER (WHERE t.debit_account_id  = a.id), 0)
            )::numeric AS balance
     FROM accounts a
     LEFT JOIN transactions t
            ON (t.credit_account_id = a.id OR t.debit_account_id = a.id)
           AND (t.date, t.created_at, t.id) < ($1::date, $2::timestamptz, $3::int)
     WHERE a.id = ANY($4::int[])
     GROUP BY a.id, a.start_balance`,
    [date, createdAt, id, accountIds]
  );
  return rows.map(r => ({ id: r.id, balance: Number(r.balance) }));
};
```

Keep the existing cursor comment above the function as is.

`getAccountBalances` was already converted in Task 3 Step 3b — leave it alone here.

- [ ] **Step 4: Update the transactions service**

In `backend/src/services/transactions.ts`, add the import:

```ts
import { LEVEL, getAccessibleAccountIds, requireLevelOnAll } from './access';
```

`loadAccount` checks write access instead of ownership:

```ts
async function loadAccount(accountId: number, userId: number, label: string): Promise<Account> {
  const account = await accountQueries.getAccountById(accountId);
  if (!account || account.deleted) {
    throw { statusCode: 403, message: `Cannot use this ${label} account` };
  }
  await requireLevelOnAll([accountId], userId, LEVEL.WRITE);
  return account;
}
```

`getTransactions` resolves access and intersects any caller-supplied account filter with it:

```ts
export const getTransactions = async (
  userId: number,
  filters: transactionQueries.TransactionFilters
) => {
  const accessibleIds = await getAccessibleAccountIds(userId);
  // A supplied `account` filter is intersected with what the user may see,
  // never trusted on its own.
  const accountIds = filters.account?.length
    ? filters.account.filter(id => accessibleIds.includes(id))
    : accessibleIds;

  const transactions = await transactionQueries.getTransactions(accountIds, filters);
  const sequential = !filters.details && !filters.category?.length && !filters.type;
  const result = sequential && transactions.length > 0
    ? await attachRunningBalances(transactions)
    : transactions;
  return result.map(toDecimalTransactionDTO);
};
```

Note the filter is now applied through `accountIds`, so drop `filters.account` before passing it down — change the call to:

```ts
  const transactions = await transactionQueries.getTransactions(accountIds, { ...filters, account: undefined });
```

`attachRunningBalances` drops its `userId` parameter and passes the page's account ids straight through:

```ts
async function attachRunningBalances(
  transactions: import('../types').TransactionDTO[]
) {
```

and inside it:

```ts
  const balanceRows = await transactionQueries.getBalancesAt(accountIds, dateStr, last.created_at, last.id);
```

- [ ] **Step 5: Enforce WRITE on update and delete**

In `updateTransaction`, fetch without a user and check both sides:

```ts
export const updateTransaction = async (id: number, userId: number, input: UpdateInput) => {
  const existing = await transactionQueries.getTransactionById(id);
  if (!existing) {
    throw { statusCode: 404, message: 'Transaction not found' };
  }

  // Write access on the accounts the transaction touches TODAY. The accounts
  // it will touch after the update are checked by validateTransactionInput ->
  // loadAccount below. Both matter: without the first check a transaction
  // could be moved off an account the user cannot write to.
  await requireLevelOnAll(
    [existing.debit_account_id, existing.credit_account_id],
    userId,
    LEVEL.WRITE
  );
```

Its two account lookups lose their `userId`:

```ts
  const existingDebitAccount = existing.debit_account_id != null
    ? await accountQueries.getAccountById(existing.debit_account_id)
    : null;
  const existingCreditAccount = existing.credit_account_id != null
    ? await accountQueries.getAccountById(existing.credit_account_id)
    : null;
```

and the write call drops it too:

```ts
  const transaction = await transactionQueries.updateTransaction(id, merged);
```

`deleteTransaction`:

```ts
export const deleteTransaction = async (id: number, userId: number): Promise<void> => {
  const existing = await transactionQueries.getTransactionById(id);
  if (!existing) {
    throw { statusCode: 404, message: 'Transaction not found' };
  }
  await requireLevelOnAll(
    [existing.debit_account_id, existing.credit_account_id],
    userId,
    LEVEL.WRITE
  );
  await transactionQueries.deleteTransaction(id);
};
```

The unused `getAccountBalances` wrapper at the bottom of this file was already updated in Task 3 Step 3b — no change needed here.

- [ ] **Step 6: Verify the whole backend compiles**

Run: `cd backend && npx tsc --noEmit`
Expected: no output (success). Any remaining error names a call site still passing `userId` — fix it before moving on.

- [ ] **Step 7: Run the full backend suite**

Run: `cd backend && npm test`
Expected: PASS, all existing suites, unchanged. A failure here means single-user behavior changed, which the spec forbids.

- [ ] **Step 8: Commit**

```bash
git add backend/src/db/queries/transactions.ts backend/src/services/transactions.ts
git commit -m "feat(sharing): filter transactions by accessible accounts, require WRITE on every touched account"
```

---

### Task 6: Sharing behavior tests

**Files:**
- Create: `backend/src/test/sharing.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1-5, through the HTTP API.
- Produces: nothing other code depends on.

- [ ] **Step 1: Write the fixture and visibility tests**

Create `backend/src/test/sharing.test.ts`:

```ts
import request from 'supertest';
import { createTestApp } from './testApp';
import { pool } from '../db';
import { LEVEL, AccessLevel } from '../services/access';

const app = createTestApp();

describe('Account sharing', () => {
  let tokenA: string;
  let tokenB: string;
  let userAId: number;
  let userBId: number;
  let a1: number; // owned by A, shared with B in most tests
  let a2: number; // owned by A, never shared
  let b1: number; // owned by B
  let expenseCategoryA: number;
  let expenseCategoryB: number;

  // GET /api/accounts performs currency conversion, which would otherwise
  // reach the real Frankfurter API.
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

  const register = async (email: string) => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email, password: 'password123' });
    const user = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    return { token: res.body.data.accessToken as string, id: user.rows[0].id as number };
  };

  const expenseCategoryOf = async (userId: number) => {
    const res = await pool.query(
      `SELECT c.id FROM categories c
       JOIN categories p ON c.parent_id = p.id
       WHERE c.user_id = $1 AND p.id = 2 LIMIT 1`,
      [userId]
    );
    return res.rows[0].id as number;
  };

  const makeAccount = async (userId: number, name: string) => {
    const res = await pool.query(
      `INSERT INTO accounts (user_id, name, currency, start_balance, scale)
       VALUES ($1, $2, 'USD', 0, 2) RETURNING id`,
      [userId, name]
    );
    return res.rows[0].id as number;
  };

  const grant = async (accountId: number, userId: number, level: AccessLevel) => {
    await pool.query(
      `INSERT INTO account_shares (account_id, user_id, level) VALUES ($1, $2, $3)
       ON CONFLICT (account_id, user_id) DO UPDATE SET level = EXCLUDED.level`,
      [accountId, userId, level]
    );
  };

  const revoke = async (accountId: number, userId: number) => {
    await pool.query('DELETE FROM account_shares WHERE account_id = $1 AND user_id = $2', [accountId, userId]);
  };

  beforeAll(async () => {
    const stamp = Date.now();
    const a = await register(`share-a${stamp}@example.com`);
    const b = await register(`share-b${stamp}@example.com`);
    tokenA = a.token; userAId = a.id;
    tokenB = b.token; userBId = b.id;

    await pool.query('UPDATE users SET name = $1 WHERE id = $2', ['Alice', userAId]);

    a1 = await makeAccount(userAId, 'A One');
    a2 = await makeAccount(userAId, 'A Two');
    b1 = await makeAccount(userBId, 'B One');

    expenseCategoryA = await expenseCategoryOf(userAId);
    expenseCategoryB = await expenseCategoryOf(userBId);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM account_shares WHERE account_id = ANY($1::int[])', [[a1, a2, b1]]);
    await pool.query('DELETE FROM transactions WHERE user_id = ANY($1::int[])', [[userAId, userBId]]);
    await pool.query('DELETE FROM accounts WHERE user_id = ANY($1::int[])', [[userAId, userBId]]);
    await pool.query('DELETE FROM categories WHERE user_id = ANY($1::int[])', [[userAId, userBId]]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [[userAId, userBId]]);
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM account_shares WHERE account_id = ANY($1::int[])', [[a1, a2, b1]]);
    await pool.query('DELETE FROM transactions WHERE user_id = ANY($1::int[])', [[userAId, userBId]]);
  });

  describe('visibility at level 1', () => {
    beforeEach(async () => {
      await grant(a1, userBId, LEVEL.READ);
    });

    it('shows the shared account to B with its level and owner name', async () => {
      const res = await request(app).get('/api/accounts').set({ Authorization: `Bearer ${tokenB}` });

      expect(res.status).toBe(200);
      const shared = res.body.data.find((a: { id: number }) => a.id === a1);
      expect(shared).toBeDefined();
      expect(shared.access_level).toBe(LEVEL.READ);
      expect(shared.owner_name).toBe('Alice');
    });

    it('does not show accounts that were not shared', async () => {
      const res = await request(app).get('/api/accounts').set({ Authorization: `Bearer ${tokenB}` });
      expect(res.body.data.find((a: { id: number }) => a.id === a2)).toBeUndefined();
    });

    it('marks the user\'s own accounts as OWNER', async () => {
      const res = await request(app).get('/api/accounts').set({ Authorization: `Bearer ${tokenB}` });
      const own = res.body.data.find((a: { id: number }) => a.id === b1);
      expect(own.access_level).toBe(LEVEL.OWNER);
    });

    it('shows B a transaction A created on the shared account', async () => {
      await pool.query(
        `INSERT INTO transactions (user_id, category_id, debit_account_id, debit, credit, date, description)
         VALUES ($1, $2, $3, 2500, 2500, '2026-03-01', 'Groceries')`,
        [userAId, expenseCategoryA, a1]
      );

      const res = await request(app).get('/api/transactions').set({ Authorization: `Bearer ${tokenB}` });

      expect(res.status).toBe(200);
      expect(res.body.data.map((t: { description: string }) => t.description)).toContain('Groceries');
    });

    it('reports the same balance to B as to A', async () => {
      await pool.query(
        `INSERT INTO transactions (user_id, category_id, debit_account_id, debit, credit, date)
         VALUES ($1, $2, $3, 2500, 2500, '2026-03-01')`,
        [userAId, expenseCategoryA, a1]
      );

      const resA = await request(app).get('/api/accounts').set({ Authorization: `Bearer ${tokenA}` });
      const resB = await request(app).get('/api/accounts').set({ Authorization: `Bearer ${tokenB}` });

      const balA = resA.body.data.find((a: { id: number }) => a.id === a1).balance;
      const balB = resB.body.data.find((a: { id: number }) => a.id === a1).balance;
      expect(balB).toBe(balA);
      expect(balA).toBe(-25);
    });
  });
});
```

- [ ] **Step 2: Run these tests to verify they pass**

Run: `cd backend && npx jest --testPathPatterns=sharing`
Expected: PASS — 5 tests. They exercise code that already exists after Tasks 1-5, so a failure means a real defect in that code, not a missing feature.

- [ ] **Step 3: Commit**

```bash
git add backend/src/test/sharing.test.ts
git commit -m "test(sharing): cover shared-account visibility and balances"
```

- [ ] **Step 4: Add the level-boundary tests**

Append inside the outer `describe`, after the `visibility at level 1` block:

```ts
  describe('level boundaries', () => {
    const expensePayload = () => ({
      debitAccountId: a1,
      categoryId: expenseCategoryB,
      debit: 10,
      credit: 10,
      date: '2026-03-02',
      description: 'By B',
    });

    const accountPayload = () => ({ name: 'Renamed', type: 'cash' as const, settings: {} });

    it('level 1 cannot create, update, or delete transactions', async () => {
      await grant(a1, userBId, LEVEL.READ);

      const created = await request(app)
        .post('/api/transactions')
        .set({ Authorization: `Bearer ${tokenB}` })
        .send(expensePayload());
      expect(created.status).toBe(403);

      const existing = await pool.query(
        `INSERT INTO transactions (user_id, category_id, debit_account_id, debit, credit, date)
         VALUES ($1, $2, $3, 500, 500, '2026-03-02') RETURNING id`,
        [userAId, expenseCategoryA, a1]
      );
      const txId = existing.rows[0].id;

      const updated = await request(app)
        .put(`/api/transactions/${txId}`)
        .set({ Authorization: `Bearer ${tokenB}` })
        .send({ description: 'hacked' });
      expect(updated.status).toBe(403);

      const deleted = await request(app)
        .delete(`/api/transactions/${txId}`)
        .set({ Authorization: `Bearer ${tokenB}` });
      expect(deleted.status).toBe(403);
    });

    it('level 2 can manage transactions but not edit the account', async () => {
      await grant(a1, userBId, LEVEL.WRITE);

      const created = await request(app)
        .post('/api/transactions')
        .set({ Authorization: `Bearer ${tokenB}` })
        .send(expensePayload());
      expect(created.status).toBe(200);
      expect(created.body.data.id).toBeDefined();

      const deleted = await request(app)
        .delete(`/api/transactions/${created.body.data.id}`)
        .set({ Authorization: `Bearer ${tokenB}` });
      expect(deleted.status).toBe(200);

      const edited = await request(app)
        .put(`/api/accounts/${a1}`)
        .set({ Authorization: `Bearer ${tokenB}` })
        .send(accountPayload());
      expect(edited.status).toBe(403);
    });

    it('level 3 can edit the account but not delete it', async () => {
      await grant(a1, userBId, LEVEL.ADMIN);

      const edited = await request(app)
        .put(`/api/accounts/${a1}`)
        .set({ Authorization: `Bearer ${tokenB}` })
        .send(accountPayload());
      expect(edited.status).toBe(200);
      expect(edited.body.data.name).toBe('Renamed');

      const removed = await request(app)
        .delete(`/api/accounts/${a1}`)
        .set({ Authorization: `Bearer ${tokenB}` });
      expect(removed.status).toBe(403);

      // restore the name for the remaining tests
      await pool.query('UPDATE accounts SET name = $1 WHERE id = $2', ['A One', a1]);
    });

    it('the owner can delete their own account', async () => {
      const throwaway = await makeAccount(userAId, 'Throwaway');
      const removed = await request(app)
        .delete(`/api/accounts/${throwaway}`)
        .set({ Authorization: `Bearer ${tokenA}` });
      expect(removed.status).toBe(200);
      expect(removed.body.data.kind).toBe('hard-deleted');
    });
  });
```

- [ ] **Step 5: Run them**

Run: `cd backend && npx jest --testPathPatterns=sharing`
Expected: PASS — 9 tests.

- [ ] **Step 6: Commit**

```bash
git add backend/src/test/sharing.test.ts
git commit -m "test(sharing): cover the permission table level by level"
```

- [ ] **Step 7: Add cross-boundary and revocation tests**

Append inside the outer `describe`:

```ts
  describe('transfers across an access boundary', () => {
    const transfer = () => ({
      debitAccountId: a1,
      creditAccountId: b1,
      debit: 30,
      credit: 30,
      date: '2026-03-03',
      description: 'A1 to B1',
    });

    it('allows the transfer with write access on both accounts and shows it to both users', async () => {
      await grant(a1, userBId, LEVEL.WRITE);

      const created = await request(app)
        .post('/api/transactions')
        .set({ Authorization: `Bearer ${tokenB}` })
        .send(transfer());
      expect(created.status).toBe(200);

      const seenByA = await request(app).get('/api/transactions').set({ Authorization: `Bearer ${tokenA}` });
      const rowA = seenByA.body.data.find((t: { description: string }) => t.description === 'A1 to B1');
      expect(rowA).toBeDefined();
      // A sees the far side in full, including B's private account name.
      expect(rowA.credit_account.name).toBe('B One');

      const seenByB = await request(app).get('/api/transactions').set({ Authorization: `Bearer ${tokenB}` });
      expect(seenByB.body.data.map((t: { description: string }) => t.description)).toContain('A1 to B1');
    });

    it('rejects the transfer when write access is missing on one side', async () => {
      await grant(a1, userBId, LEVEL.READ);

      const created = await request(app)
        .post('/api/transactions')
        .set({ Authorization: `Bearer ${tokenB}` })
        .send(transfer());
      expect(created.status).toBe(403);
    });

    it('rejects moving a transaction onto an account the user cannot reach', async () => {
      await grant(a1, userBId, LEVEL.WRITE);

      const created = await request(app)
        .post('/api/transactions')
        .set({ Authorization: `Bearer ${tokenB}` })
        .send({
          debitAccountId: a1,
          categoryId: expenseCategoryB,
          debit: 10,
          credit: 10,
          date: '2026-03-04',
        });
      expect(created.status).toBe(200);

      const moved = await request(app)
        .put(`/api/transactions/${created.body.data.id}`)
        .set({ Authorization: `Bearer ${tokenB}` })
        .send({ debitAccountId: a2 });
      expect(moved.status).toBe(403);
    });
  });

  describe('revocation', () => {
    it('hides the account and its transactions, but keeps shared transfers visible through the user\'s own side', async () => {
      await grant(a1, userBId, LEVEL.WRITE);

      await pool.query(
        `INSERT INTO transactions (user_id, category_id, debit_account_id, debit, credit, date, description)
         VALUES ($1, $2, $3, 700, 700, '2026-03-05', 'A only')`,
        [userAId, expenseCategoryA, a1]
      );
      const transferRes = await request(app)
        .post('/api/transactions')
        .set({ Authorization: `Bearer ${tokenB}` })
        .send({
          debitAccountId: a1,
          creditAccountId: b1,
          debit: 30,
          credit: 30,
          date: '2026-03-06',
          description: 'Shared transfer',
        });
      expect(transferRes.status).toBe(200);

      await revoke(a1, userBId);

      const accounts = await request(app).get('/api/accounts').set({ Authorization: `Bearer ${tokenB}` });
      expect(accounts.body.data.find((a: { id: number }) => a.id === a1)).toBeUndefined();

      const txs = await request(app).get('/api/transactions').set({ Authorization: `Bearer ${tokenB}` });
      const descriptions = txs.body.data.map((t: { description: string }) => t.description);
      expect(descriptions).not.toContain('A only');
      // The transfer still touches B's own account, so it stays visible.
      expect(descriptions).toContain('Shared transfer');

      const seenByA = await request(app).get('/api/transactions').set({ Authorization: `Bearer ${tokenA}` });
      expect(seenByA.body.data.map((t: { description: string }) => t.description)).toContain('Shared transfer');
    });

    it('stops a revoked user from writing to the account', async () => {
      await grant(a1, userBId, LEVEL.WRITE);
      await revoke(a1, userBId);

      const created = await request(app)
        .post('/api/transactions')
        .set({ Authorization: `Bearer ${tokenB}` })
        .send({
          debitAccountId: a1,
          categoryId: expenseCategoryB,
          debit: 10,
          credit: 10,
          date: '2026-03-07',
        });
      expect(created.status).toBe(403);
    });
  });
```

- [ ] **Step 8: Run the whole backend suite**

Run: `cd backend && npm test`
Expected: PASS everywhere — the five existing suites unchanged, plus `access.test.ts` and `sharing.test.ts` (14 sharing tests).

- [ ] **Step 9: Commit**

```bash
git add backend/src/test/sharing.test.ts
git commit -m "test(sharing): cover cross-boundary transfers and revocation"
```

---

### Task 7: Frontend account type

**Files:**
- Modify: `frontend/src/app/models/account.ts`
- Test: existing frontend suite must pass unchanged

**Interfaces:**
- Consumes: the `access_level` / `owner_name` fields the API now returns (Task 4).
- Produces: nothing — type-only change.

- [ ] **Step 1: Add the fields to `AccountBase`**

In `frontend/src/app/models/account.ts`, add to `interface AccountBase`, after `created_at`:

```ts
  /**
   * The signed-in user's access level on this account:
   * 1 read, 2 transactions, 3 admin, 4 owner. Optional so existing
   * fixtures and forms need not supply it.
   */
  access_level?: 1 | 2 | 3 | 4;
  /** Display name of the account's owner. */
  owner_name?: string;
```

Both are optional on purpose: six existing `*.spec.ts` files build `Account` literals, and required fields would break their compilation for no benefit. No UI reads these yet — hiding edit controls on accounts the user cannot modify belongs to the sharing-UI task, and until then the backend returns 403.

- [ ] **Step 2: Run the frontend tests**

Run: `cd frontend && npm test`
Expected: PASS, unchanged. Use `npm test` / `ng test`, never bare `npx vitest run` — raw vitest bypasses the builder config that wires up Zone.js/TestBed.

- [ ] **Step 3: Commit**

```bash
git add frontend/src/app/models/account.ts
git commit -m "feat(sharing): expose access_level and owner_name on the Account model"
```

---

### Task 8: Update project documentation

**Files:**
- Modify: `CLAUDE.md`

**Interfaces:**
- Consumes: the finished feature.
- Produces: nothing.

- [ ] **Step 1: Correct the scope line**

`CLAUDE.md` opens by saying sharing is "no sharing/invites yet — deferred, not built". Replace that parenthetical in the "What this is" section:

```
A personal finance management web app: multi-user, with per-account sharing
(read / write / admin) between users; permissions are granted by direct SQL
for now, with no UI. Core scope for now: income/expense transactions with
hierarchical categories, multi-currency accounts, manual entry (CSV
bank-statement import planned, not built). Investments/assets and
analytics/reports are deferred to later phases.
```

- [ ] **Step 2: Document the table and the access rule**

In the `### Database` section, after the transactions bullet, add:

```
- `account_shares` added in migration 009: `(account_id, user_id, level)`,
  level 1 = read, 2 = transactions, 3 = admin. The owner is **not** stored
  there — `accounts.user_id` is the only source of ownership, and
  `services/access.ts` synthesises level 4 (owner) for owned accounts.
```

And after the transactions table in the `#### Transactions` subsection:

```
Visibility follows accounts, not `transactions.user_id`: a transaction is
visible when the user can reach at least one of its accounts.
`transactions.user_id` records who entered the row and must never be used as
an access filter. Permission checks live in the service layer via
`requireLevel` / `requireLevelOnAll`; `db/queries/*` filter by account id
only.
```

- [ ] **Step 3: Verify nothing else in CLAUDE.md contradicts the feature**

Run: `grep -n "sharing\|user_id" CLAUDE.md`
Expected: every hit is either one of the lines just written or an unrelated mention (system categories' `user_id IS NULL`). Fix any remaining claim that sharing does not exist.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: describe account sharing and the account-based access rule"
```

---

## Final Verification

- [ ] **Full backend suite:** `cd backend && npm test` — all suites pass, including the five that existed before this feature, unmodified.
- [ ] **Type check:** `cd backend && npx tsc --noEmit` — no output.
- [ ] **Frontend suite:** `cd frontend && npm test` — passes.
- [ ] **No stray ownership filters:** `cd backend && grep -rn "user_id = \$" src/db/queries/`

  Before this feature the hits are: 5 in `accounts.ts`, 8 in `transactions.ts`, 4 in `categories.ts`. Afterwards the only legitimate hits are:
  - `accountShares.ts` — `getAccessRows`, where `user_id` correctly selects the user's own accounts and their grants.
  - `categories.ts` — unchanged by this feature.
  - `users.ts` — unchanged.

  There must be **zero** hits in `accounts.ts` and **zero** in `transactions.ts`. Any hit in either file is a missed ownership filter.
- [ ] **Author preserved:** `cd backend && grep -n "user_id" src/db/queries/transactions.ts` — `user_id` appears only in the `INSERT` column list of `createTransaction`.
