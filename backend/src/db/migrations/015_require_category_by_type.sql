-- 015_require_category_by_type.sql
-- An expense or income always has a category (a missing one is filed as the
-- system Uncategorized, 3 / 4) and a transfer never does. The services
-- already keep to this; the constraint makes it hold for every writer.
-- Rows with neither account are left unconstrained.
UPDATE transactions SET category_id = 4
 WHERE category_id IS NULL AND debit_account_id IS NOT NULL AND credit_account_id IS NULL;
UPDATE transactions SET category_id = 3
 WHERE category_id IS NULL AND debit_account_id IS NULL AND credit_account_id IS NOT NULL;

ALTER TABLE transactions ADD CONSTRAINT chk_transactions_category CHECK (
  CASE
    WHEN debit_account_id IS NOT NULL AND credit_account_id IS NOT NULL THEN category_id IS NULL
    WHEN debit_account_id IS NOT NULL OR credit_account_id IS NOT NULL THEN category_id IS NOT NULL
    ELSE TRUE
  END
);
