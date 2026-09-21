-- Identity for imported transactions. NULL for hand-entered rows, which the
-- partial indexes therefore never constrain against each other.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS import_hash TEXT;

-- Two indexes because the account id lives in a different column for income
-- than for expense. A hash is unique only WITHIN an account: the same
-- statement imported into two accounts is two legitimate sets of rows.
--
-- These are the real idempotency guarantee. The service checks for existing
-- hashes before inserting, but that check and the insert are not atomic
-- against a concurrent request; the index makes a double-submit impossible
-- rather than merely unlikely.
CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_import_hash_debit
  ON transactions(debit_account_id, import_hash)
  WHERE import_hash IS NOT NULL AND debit_account_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_import_hash_credit
  ON transactions(credit_account_id, import_hash)
  WHERE import_hash IS NOT NULL AND credit_account_id IS NOT NULL;
