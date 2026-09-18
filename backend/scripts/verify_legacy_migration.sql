-- Verify a legacy migration performed by migrate_legacy_swarmerdb.sql.
--
--   psql -h localhost -U finance_user -d <target_db> -v ON_ERROR_STOP=1 \
--        -f backend/scripts/verify_legacy_migration.sql
--
-- Every 'bad' column must read 0, and every balance must match the legacy one.
-- Reads the legacy database through the same FDW parameters as the migration.

\if :{?legacy_password} \else
  \echo 'ERROR: legacy_password is required, e.g. -v legacy_password=<password>'
  \quit
\endif
\if :{?legacy_users}    \else \set legacy_users 1,2       \endif
\if :{?legacy_db}       \else \set legacy_db swarmerdb    \endif
\if :{?legacy_user}     \else \set legacy_user swarmer    \endif
\if :{?legacy_host}     \else \set legacy_host localhost  \endif
\if :{?legacy_port}     \else \set legacy_port 5432       \endif

BEGIN;

CREATE EXTENSION IF NOT EXISTS postgres_fdw;
CREATE SERVER IF NOT EXISTS verify_srv FOREIGN DATA WRAPPER postgres_fdw
  OPTIONS (host :'legacy_host', port :'legacy_port', dbname :'legacy_db');
CREATE USER MAPPING IF NOT EXISTS FOR CURRENT_USER SERVER verify_srv
  OPTIONS (user :'legacy_user', password :'legacy_password');
CREATE SCHEMA IF NOT EXISTS vlegacy;
IMPORT FOREIGN SCHEMA public
  LIMIT TO (users, account_groups, accounts, acl, categories, transactions)
  FROM SERVER verify_srv INTO vlegacy;

\echo ''
\echo '== row counts (new vs legacy) =='
SELECT 'users'        AS entity,
       (SELECT count(*) FROM users)        AS new,
       (SELECT count(*) FROM vlegacy.users WHERE id IN (:legacy_users)) AS legacy
UNION ALL
SELECT 'accounts',
       (SELECT count(*) FROM accounts),
       (SELECT count(*) FROM vlegacy.accounts a JOIN vlegacy.account_groups g ON g.id = a.group_id
        WHERE g.owner_id IN (:legacy_users))
UNION ALL
SELECT 'transactions',
       (SELECT count(*) FROM transactions),
       (SELECT count(*) FROM vlegacy.transactions WHERE owner_id IN (:legacy_users))
UNION ALL
SELECT ' - expense',
       (SELECT count(*) FROM transactions WHERE debit_account_id IS NOT NULL AND credit_account_id IS NULL),
       (SELECT count(*) FROM vlegacy.transactions WHERE owner_id IN (:legacy_users)
          AND account_id IS NOT NULL AND recipient_id IS NULL)
UNION ALL
SELECT ' - income',
       (SELECT count(*) FROM transactions WHERE debit_account_id IS NULL AND credit_account_id IS NOT NULL),
       (SELECT count(*) FROM vlegacy.transactions WHERE owner_id IN (:legacy_users)
          AND account_id IS NULL AND recipient_id IS NOT NULL)
UNION ALL
SELECT ' - transfer',
       (SELECT count(*) FROM transactions WHERE debit_account_id IS NOT NULL AND credit_account_id IS NOT NULL),
       (SELECT count(*) FROM vlegacy.transactions WHERE owner_id IN (:legacy_users)
          AND account_id IS NOT NULL AND recipient_id IS NOT NULL);

\echo ''
\echo '== balances: accounts whose balance differs from legacy (must be empty) =='
WITH new_bal AS (
  SELECT a.id,
         a.start_balance
           - coalesce((SELECT sum(t.debit)  FROM transactions t WHERE t.debit_account_id  = a.id), 0)
           + coalesce((SELECT sum(t.credit) FROM transactions t WHERE t.credit_account_id = a.id), 0) AS bal
  FROM accounts a
), old_bal AS (
  SELECT a.id,
         a.start_balance
           - coalesce((SELECT sum(t.debit)  FROM vlegacy.transactions t WHERE t.account_id   = a.id), 0)
           + coalesce((SELECT sum(t.credit) FROM vlegacy.transactions t WHERE t.recipient_id = a.id), 0) AS bal
  FROM vlegacy.accounts a
  JOIN vlegacy.account_groups g ON g.id = a.group_id
  WHERE g.owner_id IN (:legacy_users)
)
SELECT n.id, o.bal AS legacy_balance, n.bal AS new_balance, n.bal - o.bal AS diff
FROM new_bal n FULL JOIN old_bal o ON o.id = n.id
WHERE n.bal IS DISTINCT FROM o.bal
ORDER BY 1;

\echo ''
\echo '== schema invariants (every count must be 0) =='
SELECT 'expense/income without category' AS invariant, count(*) AS bad
FROM transactions
WHERE category_id IS NULL AND NOT (debit_account_id IS NOT NULL AND credit_account_id IS NOT NULL)
UNION ALL
SELECT 'transfer carrying a category', count(*)
FROM transactions
WHERE category_id IS NOT NULL AND debit_account_id IS NOT NULL AND credit_account_id IS NOT NULL
UNION ALL
SELECT 'expense/income with debit <> credit', count(*)
FROM transactions
WHERE debit <> credit AND NOT (debit_account_id IS NOT NULL AND credit_account_id IS NOT NULL)
UNION ALL
SELECT 'non-positive amount', count(*) FROM transactions WHERE debit <= 0 OR credit <= 0
UNION ALL
SELECT 'transaction with no account', count(*)
FROM transactions WHERE debit_account_id IS NULL AND credit_account_id IS NULL
UNION ALL
SELECT 'category owned by another user', count(*)
FROM transactions t JOIN categories c ON c.id = t.category_id
WHERE c.user_id IS NOT NULL AND c.user_id <> t.user_id
UNION ALL
SELECT 'owner cannot reach either account', count(*)
FROM transactions t
WHERE NOT EXISTS (
  SELECT 1 FROM accounts a
  WHERE a.id IN (t.debit_account_id, t.credit_account_id)
    AND (a.user_id = t.user_id
         OR EXISTS (SELECT 1 FROM account_shares s
                    WHERE s.account_id = a.id AND s.user_id = t.user_id)))
UNION ALL
SELECT 'user category outside a system root', count(*)
FROM categories WHERE user_id IS NOT NULL AND parent_id IS NULL
UNION ALL
SELECT 'password still carrying {bcrypt}', count(*)
FROM users WHERE password_hash LIKE '{bcrypt}%'
UNION ALL
SELECT 'owner stored in account_shares', count(*)
FROM account_shares s JOIN accounts a ON a.id = s.account_id WHERE a.user_id = s.user_id;

ROLLBACK;
