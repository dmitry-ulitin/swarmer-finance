-- 006_currency_format.sql
-- Enforce currency format: 3 (ISO 4217, e.g. USD, EUR) or 4 (crypto-style
-- tickers like USDT, USDC) uppercase ASCII letters.
--
-- The schema's `accounts.currency` and `transactions.currency` columns
-- are plain TEXT; without a constraint any garbage string ("foo", "12",
-- "us", "USDX") flows through the API and ends up in the database. This
-- matters for same-currency / cross-currency matching in
-- services/transactions.ts:validateTransactionInput, where malformed
-- currency values silently bypass the rule.
--
-- Defense in depth: the API layer (Zod) rejects bad values with 400, and
-- this CHECK constraint catches anything that bypasses the API (direct
-- SQL, future migrations, manual DB edits).
--
-- Normalisation step: existing values are uppercased + trimmed. Anything
-- that still does not match the pattern after normalisation (e.g. '12',
-- 'DOLLARS', '') is replaced with 'USD' as a safe fallback — these are
-- not real currency codes and would otherwise block the migration. This
-- is acceptable for a personal-finance app where a default fallback is
-- strictly better than rejecting the whole migration.
UPDATE accounts
  SET currency = 'USD'
  WHERE currency !~ '^[A-Z]{3,4}$';

UPDATE accounts
  SET currency = UPPER(TRIM(currency))
  WHERE currency ~ '^[a-z]{3,4}$' OR currency ~ '^[A-Z]{3,4}[ ]+[A-Z]{3,4}$';

UPDATE transactions
  SET currency = 'USD'
  WHERE currency IS NOT NULL AND currency !~ '^[A-Z]{3,4}$';

UPDATE transactions
  SET currency = UPPER(TRIM(currency))
  WHERE currency IS NOT NULL
    AND (currency ~ '^[a-z]{3,4}$' OR currency ~ '^[A-Z]{3,4}[ ]+[A-Z]{3,4}$');

ALTER TABLE accounts
  ADD CONSTRAINT chk_accounts_currency_format
  CHECK (currency ~ '^[A-Z]{3,4}$');

ALTER TABLE transactions
  ADD CONSTRAINT chk_transactions_currency_format
  CHECK (currency IS NULL OR currency ~ '^[A-Z]{3,4}$');