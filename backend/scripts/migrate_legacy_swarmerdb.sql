-- Migrate legacy users from the old swarmerdb schema into the current one.
--
--   psql -h localhost -U finance_user -d <target_db> -v ON_ERROR_STOP=1 \
--        -f backend/scripts/migrate_legacy_swarmerdb.sql
--
-- The target database must be empty apart from the migrations (001-009 applied,
-- no users/accounts/transactions) -- accounts and categories are inserted with
-- explicit ids derived from the legacy ones, so pre-existing rows would clash.
--
-- Override any parameter with -v, e.g. -v legacy_users=1,2,5
--
-- Mapping rules (agreed with the user):
--   account name      g.name / a.name, falling back to a.currency when a.name is blank
--   deleted           a.deleted OR g.deleted
--   category roots    legacy Expense(1) -> new Expenses(2), legacy Income(2) -> new Income(1)
--   Correction(3)     tree dropped; its transactions go to system Uncategorized
--                     (3 income / 4 expense) with 'Correction. ' prefixed to description
--   duplicate siblings collapsed onto the lowest legacy id
--   transaction owner  the account's owner, so every row stays reachable;
--                     a category owned by the other user is copied into that
--                     owner's tree at the same path
--   uncategorised expense/income  -> system Uncategorized (4 / 3)
--   transfers         keep NULL category
--   passwords         legacy '{bcrypt}' prefix stripped

-- Parameters (only set when not already supplied on the command line).
\if :{?legacy_password} \else
  \echo 'ERROR: legacy_password is required, e.g. -v legacy_password=<password>'
  \quit
\endif
\if :{?legacy_users}    \else \set legacy_users 1,2          \endif
\if :{?legacy_db}       \else \set legacy_db swarmerdb       \endif
\if :{?legacy_user}     \else \set legacy_user swarmer       \endif
\if :{?legacy_host}     \else \set legacy_host localhost     \endif
\if :{?legacy_port}     \else \set legacy_port 5432          \endif

BEGIN;

CREATE EXTENSION IF NOT EXISTS postgres_fdw;

CREATE SERVER legacy_srv FOREIGN DATA WRAPPER postgres_fdw
  OPTIONS (host :'legacy_host', port :'legacy_port', dbname :'legacy_db');
CREATE USER MAPPING FOR CURRENT_USER SERVER legacy_srv
  OPTIONS (user :'legacy_user', password :'legacy_password');

CREATE SCHEMA legacy;
IMPORT FOREIGN SCHEMA public
  LIMIT TO (users, account_groups, accounts, acl, categories, transactions)
  FROM SERVER legacy_srv INTO legacy;

-- ---------------------------------------------------------------- users
-- email is UNIQUE in the new schema, so it is a safe join key back to the source.
CREATE TEMP TABLE u_map AS
WITH ins AS (
  INSERT INTO users (email, password_hash, name, currency, currency_scale)
  SELECT u.email,
         regexp_replace(u.password, '^\{bcrypt\}', ''),
         u.name,
         u.currency,
         2
  FROM legacy.users u
  WHERE u.id IN (:legacy_users)
  RETURNING id, email
)
SELECT lu.id AS old_id, ins.id AS new_id
FROM ins JOIN legacy.users lu ON lu.email = ins.email;

-- ------------------------------------------------------------ categories
-- Legacy roots: 1 = Expense, 2 = Income, 3 = Correction (dropped).
-- New system roots: 1 = Income, 2 = Expenses.
CREATE TEMP TABLE c_src AS
WITH RECURSIVE tree AS (
  SELECT c.id, c.owner_id, c.parent_id, c.name, c.parent_id AS root, 1 AS depth
  FROM legacy.categories c
  WHERE c.parent_id IN (1, 2, 3) AND c.owner_id IN (:legacy_users)
  UNION ALL
  SELECT c.id, c.owner_id, c.parent_id, c.name, t.root, t.depth + 1
  FROM legacy.categories c
  JOIN tree t ON c.parent_id = t.id
  WHERE c.owner_id IN (:legacy_users)
)
SELECT * FROM tree WHERE root IN (1, 2);   -- Correction subtree excluded

-- Collapse same-name siblings onto the lowest legacy id.
CREATE TEMP TABLE c_canon AS
SELECT s.id AS old_id,
       min(s.id) OVER (PARTITION BY s.owner_id, s.parent_id, s.name) AS canon_id
FROM c_src s;

-- Ids are assigned explicitly (legacy id + offset) to keep the mapping
-- deterministic; the offset clears the system categories 1-4.
CREATE TEMP TABLE c_map AS
SELECT s.id AS old_id, (s.id + 1000)::int AS new_id
FROM c_src s
JOIN c_canon k ON k.old_id = s.id AND k.canon_id = s.id;

-- Insert level by level so parents always exist before their children.
DO $$
DECLARE
  lvl int;
BEGIN
  FOR lvl IN SELECT DISTINCT depth FROM c_src ORDER BY depth LOOP
    INSERT INTO categories (id, user_id, name, parent_id)
    SELECT cm.new_id,
           m.new_id,
           s.name,
           CASE
             -- top level: attach to the new system root
             WHEN s.parent_id IN (1, 2)
               THEN CASE s.root WHEN 1 THEN 2 ELSE 1 END
             ELSE (SELECT cm2.new_id FROM c_map cm2
                   JOIN c_canon kk ON kk.old_id = s.parent_id
                   WHERE cm2.old_id = kk.canon_id)
           END
    FROM c_src s
    JOIN c_map cm ON cm.old_id = s.id          -- canonical rows only
    JOIN u_map m ON m.old_id = s.owner_id
    WHERE s.depth = lvl;
  END LOOP;
END $$;

SELECT setval('categories_id_seq', (SELECT max(id) + 1 FROM categories));

-- Non-canonical duplicates resolve to their canonical twin.
INSERT INTO c_map (old_id, new_id)
SELECT k.old_id, cm.new_id
FROM c_canon k
JOIN c_map cm ON cm.old_id = k.canon_id
WHERE k.old_id <> k.canon_id;

-- -------------------------------------------------------------- accounts
-- Duplicate names ('alfabank / USD') rule out a natural key, so ids are assigned
-- explicitly and the legacy id is carried straight through.
CREATE TEMP TABLE a_map AS
SELECT a.id AS old_id,
       a.id::int AS new_id,
       g.owner_id,
       g.name || ' / ' || coalesce(nullif(trim(a.name), ''), a.currency) AS name,
       a.currency,
       a.scale,
       a.start_balance,
       (a.deleted OR g.deleted) AS deleted
FROM legacy.accounts a
JOIN legacy.account_groups g ON g.id = a.group_id
WHERE g.owner_id IN (:legacy_users);

INSERT INTO accounts (id, user_id, name, currency, scale, start_balance, deleted)
SELECT s.new_id, m.new_id, s.name, s.currency, s.scale, s.start_balance, s.deleted
FROM a_map s
JOIN u_map m ON m.old_id = s.owner_id;

SELECT setval('accounts_id_seq', (SELECT max(id) + 1 FROM accounts));

-- -------------------------------------------------------- account_shares
-- Legacy ACL is per group; the new schema is per account.
-- is_admin -> 3, is_readonly -> 1, otherwise -> 2 (transactions).
-- The owner is never stored in account_shares.
INSERT INTO account_shares (account_id, user_id, level)
SELECT DISTINCT am.new_id,
       um.new_id,
       CASE WHEN acl.is_admin THEN 3 WHEN acl.is_readonly THEN 1 ELSE 2 END
FROM legacy.acl acl
JOIN legacy.account_groups g ON g.id = acl.group_id
JOIN legacy.accounts a ON a.group_id = g.id
JOIN a_map am ON am.old_id = a.id
JOIN u_map um ON um.old_id = acl.user_id
WHERE g.owner_id IN (:legacy_users)
  AND acl.user_id IN (:legacy_users)
  AND acl.user_id <> g.owner_id;

-- ---------------------------------------------------------- transactions
-- The owner is the user who owns the account, so the row stays reachable.
-- For a transfer between accounts of different owners, that is the side that
-- can see both accounts (the credit owner, who holds shares on the other).
CREATE TEMP TABLE t_src AS
SELECT
  t.id,
  CASE
    WHEN da.owner_id IS NOT NULL AND ca.owner_id IS NOT NULL
         AND da.owner_id <> ca.owner_id THEN ca.owner_id
    ELSE coalesce(da.owner_id, ca.owner_id)
  END AS owner_old,
  cm.new_id AS category_id,
  da.new_id AS debit_account_id,
  ca.new_id AS credit_account_id,
  t.debit,
  -- expense/income must carry equal amounts; only legacy txn 2418 differs
  CASE WHEN t.account_id IS NOT NULL AND t.recipient_id IS NULL THEN t.debit
       ELSE t.credit END AS credit,
  t.opdate::date AS date,
  CASE WHEN lc.root = 3 THEN 'Correction. ' || coalesce(t.details, '')
       ELSE coalesce(t.details, '') END AS description,
  t.party AS payee,
  (t.account_id IS NOT NULL AND t.recipient_id IS NOT NULL) AS is_transfer,
  (t.account_id IS NOT NULL) AS is_expense
FROM legacy.transactions t
LEFT JOIN a_map da ON da.old_id = t.account_id
LEFT JOIN a_map ca ON ca.old_id = t.recipient_id
LEFT JOIN c_map cm ON cm.old_id = t.category_id
LEFT JOIN LATERAL (
  WITH RECURSIVE up AS (
    SELECT c.id, c.parent_id FROM legacy.categories c WHERE c.id = t.category_id
    UNION ALL
    SELECT c.id, c.parent_id FROM legacy.categories c JOIN up ON up.parent_id = c.id
  )
  SELECT id AS root FROM up WHERE parent_id IS NULL
) lc ON true
WHERE t.owner_id IN (:legacy_users);

-- A category belonging to the other user is resolved to the owner's own
-- category at the same path (the two trees largely mirror each other), and only
-- created when that path is missing. cat_map holds the resolution per user.
CREATE TEMP TABLE cat_path AS
WITH RECURSIVE p AS (
  SELECT c.id, c.user_id, c.parent_id, c.name::text AS path,
         c.parent_id AS root, 1 AS depth
  FROM categories c
  WHERE c.user_id IS NOT NULL AND c.parent_id IN (1, 2)
  UNION ALL
  SELECT c.id, c.user_id, c.parent_id, p.path || '/' || c.name, p.root, p.depth + 1
  FROM categories c JOIN p ON c.parent_id = p.id
  WHERE c.user_id IS NOT NULL
)
SELECT * FROM p;

CREATE TEMP TABLE cat_map (want_user int, src_id int, new_id int);

DO $$
DECLARE
  cur_lvl int;
BEGIN
  FOR cur_lvl IN 1..4 LOOP
    -- 1. reuse the owner's existing category at the same (root, path)
    INSERT INTO cat_map (want_user, src_id, new_id)
    SELECT DISTINCT need.want_user, need.src_id, mine.id
    FROM (
      SELECT DISTINCT um.new_id AS want_user, anc.id AS src_id
      FROM t_src s
      JOIN u_map um ON um.old_id = s.owner_old
      JOIN cat_path src ON src.id = s.category_id
      JOIN cat_path anc ON anc.id = ANY (
        ARRAY(SELECT a.id FROM cat_path a
              WHERE src.path = a.path OR src.path LIKE a.path || '/%')
      ) AND anc.user_id = src.user_id
      WHERE src.user_id <> um.new_id AND anc.depth = cur_lvl
    ) need
    JOIN cat_path srcp ON srcp.id = need.src_id
    JOIN cat_path mine ON mine.user_id = need.want_user
                      AND mine.path = srcp.path
                      AND mine.root = srcp.root
    WHERE NOT EXISTS (SELECT 1 FROM cat_map cm
                      WHERE cm.want_user = need.want_user AND cm.src_id = need.src_id);

    -- 2. otherwise create it under the already-resolved parent
    WITH need AS (
      SELECT DISTINCT um.new_id AS want_user, anc.id AS src_id
      FROM t_src s
      JOIN u_map um ON um.old_id = s.owner_old
      JOIN cat_path src ON src.id = s.category_id
      JOIN cat_path anc ON (src.path = anc.path OR src.path LIKE anc.path || '/%')
                       AND anc.user_id = src.user_id
      WHERE src.user_id <> um.new_id AND anc.depth = cur_lvl
    ), missing AS (
      SELECT n.want_user, n.src_id, nextval('categories_id_seq')::int AS new_id
      FROM need n
      WHERE NOT EXISTS (SELECT 1 FROM cat_map cm
                        WHERE cm.want_user = n.want_user AND cm.src_id = n.src_id)
    ), ins AS (
      INSERT INTO categories (id, user_id, name, parent_id, color, icon)
      SELECT m.new_id, m.want_user, c.name,
             CASE WHEN c.parent_id IN (1, 2) THEN c.parent_id   -- system root
                  ELSE (SELECT cm.new_id FROM cat_map cm
                        WHERE cm.src_id = c.parent_id AND cm.want_user = m.want_user)
             END,
             c.color, c.icon
      FROM missing m JOIN categories c ON c.id = m.src_id
      RETURNING id
    )
    INSERT INTO cat_map (want_user, src_id, new_id)
    SELECT m.want_user, m.src_id, m.new_id FROM missing m
    WHERE m.new_id IN (SELECT id FROM ins);

    -- newly created rows join the path table for the next level
    INSERT INTO cat_path (id, user_id, parent_id, path, root, depth)
    SELECT c.id, c.user_id, c.parent_id,
           CASE WHEN c.parent_id IN (1, 2) THEN c.name::text
                ELSE (SELECT pp.path FROM cat_path pp WHERE pp.id = c.parent_id) || '/' || c.name
           END,
           CASE WHEN c.parent_id IN (1, 2) THEN c.parent_id
                ELSE (SELECT pp.root FROM cat_path pp WHERE pp.id = c.parent_id) END,
           cur_lvl
    FROM categories c
    WHERE c.user_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM cat_path x WHERE x.id = c.id);
  END LOOP;
END $$;

INSERT INTO transactions (user_id, category_id, debit_account_id, credit_account_id,
                          debit, credit, date, description, payee)
SELECT
  um.new_id,
  CASE
    WHEN s.is_transfer THEN NULL
    WHEN s.category_id IS NULL THEN CASE WHEN s.is_expense THEN 4 ELSE 3 END
    WHEN c.user_id = um.new_id THEN s.category_id
    ELSE cp.new_id           -- the owner's equivalent of the other user's category
  END,
  s.debit_account_id, s.credit_account_id, s.debit, s.credit,
  s.date, s.description, s.payee
FROM t_src s
JOIN u_map um ON um.old_id = s.owner_old
LEFT JOIN categories c ON c.id = s.category_id
LEFT JOIN cat_map cp ON cp.src_id = s.category_id AND cp.want_user = um.new_id;

COMMIT;
