# Legacy migration (swarmerdb → current schema)

Moves users, accounts, categories, sharing and transactions from the old
Flyway-managed `swarmerdb` schema into the current one.

- `migrate_legacy_swarmerdb.sql` — the migration
- `verify_legacy_migration.sql` — checks the result against the legacy data

Both read the legacy database over `postgres_fdw`, so the two databases may live
on the same server or on different hosts. Neither writes to the legacy database.

## Running it

The target database must have migrations 001–009 applied and hold **no**
users/accounts/transactions — accounts and categories are inserted with explicit
ids derived from the legacy ones, so existing rows would collide.

```bash
# 1. create the target database and build the schema
psql -h localhost -U finance_user -d postgres -c "CREATE DATABASE finance_db_nu OWNER finance_user;"
cd backend && DATABASE_URL="postgresql://finance_user:***@localhost:5432/finance_db_nu" npm run migrate

# 2. load the legacy dump into swarmerdb, if it isn't there yet
psql "postgresql://swarmer:***@localhost:5432/swarmerdb" -f ~/projects/swarmerdb-nu.sql

# 3. migrate, then verify
psql -h localhost -U finance_user -d finance_db_nu -v ON_ERROR_STOP=1 \
     -v legacy_password="$LEGACY_PASSWORD" -f backend/scripts/migrate_legacy_swarmerdb.sql
psql -h localhost -U finance_user -d finance_db_nu -v ON_ERROR_STOP=1 \
     -v legacy_password="$LEGACY_PASSWORD" -f backend/scripts/verify_legacy_migration.sql
```

The whole migration is one transaction: it either lands completely or not at
all. It is not idempotent — to re-run it, drop and rebuild the target database.

### Parameters

Override with `-v name=value`; defaults suit the local setup.

| Parameter | Default | Meaning |
|---|---|---|
| `legacy_users` | `1,2` | legacy `users.id` to migrate |
| `legacy_db` | `swarmerdb` | legacy database name |
| `legacy_user` | `swarmer` | legacy role |
| `legacy_password` | *(required)* | its password — no default, pass it on the command line |
| `legacy_host` / `legacy_port` | `localhost` / `5432` | legacy server |

```bash
psql ... -v legacy_users=1,2,5 -f backend/scripts/migrate_legacy_swarmerdb.sql
```

Migrating users in separate runs is **not** supported: sharing and cross-user
categories are resolved within one run, so everyone who shares accounts has to
be migrated together.

## How the schemas differ

| Legacy | Current |
|---|---|
| accounts grouped by `account_groups` | flat `accounts` |
| `acl` grants per **group** | `account_shares` per **account** |
| `transactions.account_id` / `recipient_id` | `debit_account_id` / `credit_account_id` |
| category roots `Expense` / `Income` / `Correction` | system roots `Income` (1) / `Expenses` (2) + `Uncategorized` (3/4) |
| `users.password` as `{bcrypt}$2a$…` | `password_hash` as `$2a$…` |

## Mapping rules

Decisions taken for the 2026-09-18 migration of users 1 (Dmitry) and 2 (Nata).

**Accounts.** Named `"<group> / <account>"`; when the account name is blank
(NULL or empty) its currency is used instead — `tinkoff ...3272 / RUB`. Deleted
is `account.deleted OR group.deleted`, so an account of a deleted group is
migrated as deleted. Legacy ids carry over unchanged.

Duplicate names are left as they are: in this dataset only `alfabank / EUR` and
`alfabank / USD` collide, and each pair holds one live and one deleted account,
so nothing ambiguous is visible in the UI. Re-check this with a different set of
users.

**Sharing.** A group grant expands to one row per account of that group.
`is_admin` → level 3, `is_readonly` → level 1, otherwise level 2
(transactions). The owner is never written to `account_shares` — `accounts.user_id`
stays the single source of ownership.

**Categories.** The legacy `Expense` tree moves under `Expenses` (2) and
`Income` under `Income` (1). Same-name siblings — which the legacy schema allowed
and the current unique index does not — collapse onto the lowest legacy id.

The `Correction` root has no counterpart here. Its tree is dropped and its
transactions go to the system `Uncategorized` (3 for income, 4 for expense) with
`Correction. ` prefixed to the description, so they stay findable.

**Transaction owner.** `user_id` is set to the **owner of the account**, not to
the legacy `owner_id`, because visibility follows accounts: a row whose owner
cannot reach either of its accounts would disappear from every query. For a
transfer between accounts of different owners it is the side that can see both.

Legacy let one user categorise with the other's tree, which the current schema
rejects. Such a reference resolves to the new owner's own category at the same
path, and only when that path is missing is a copy created. In the 2026-09-18
run 62 of 63 references found an existing twin; one category — `Bills/Subscriptions`
— was copied into Dmitry's tree.

**Amounts.** `debit`/`credit` are integer minor units in both schemas and are
copied verbatim. Expense and income must carry equal amounts here, so `credit`
is forced to `debit`; exactly one legacy row (id 2418, 280.46 vs 3.30) was
affected. Transfers keep both amounts and carry no category.

**Passwords.** The `{bcrypt}` prefix is stripped, leaving a `$2a$` hash that
`bcryptjs` verifies — users keep their existing passwords.

## What the verification covers

`verify_legacy_migration.sql` runs inside a transaction it rolls back, so it is
safe against a live database. It checks three things:

1. row counts per entity and per transaction type, new vs legacy;
2. every account's balance (`start_balance − debits + credits`) against the
   legacy balance — the table must come back **empty**;
3. ten schema invariants, each of which must be `0`.

The 2026-09-18 run: 2 users, 62 accounts, 80 categories (76 user + 4 system),
29 shares, 15 182 transactions (12 127 expense / 1 876 income / 1 179 transfer),
all balances identical, all invariants zero.
