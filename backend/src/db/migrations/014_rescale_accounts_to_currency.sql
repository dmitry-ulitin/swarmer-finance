-- 014_rescale_accounts_to_currency.sql
-- Accounts used to get scale 2 whatever their currency (the API defaulted it
-- and the form never sent one), so a BTC account could only hold cents of a
-- bitcoin. Scale now follows the currency (services/currencyScale.ts); this
-- moves existing accounts to it.
--
-- Amounts are integers at the account's scale, so each one is multiplied by
-- 10^(new - old): 150 at scale 2 (1.50 BTC) becomes 150000000 at scale 8.
-- Only increases are applied — they are exact. A decrease (e.g. a JPY account
-- stored at 2) could drop fractions, so such accounts are left as they are.
-- A transfer's two amounts belong to its two accounts, so each side is
-- rescaled only when its own account is.
--
-- Runs once through migrate; safe to re-run, as fixed accounts no longer match.
CREATE TEMP TABLE currency_scales (currency TEXT PRIMARY KEY, scale INTEGER NOT NULL) ON COMMIT DROP;
INSERT INTO currency_scales VALUES
  ('BTC', 8), ('ETH', 8), ('USDT', 6), ('USDC', 6), ('SOL', 9), ('TON', 9), ('TRX', 6),
  ('BHD', 3), ('JOD', 3), ('KWD', 3), ('OMR', 3), ('TND', 3), ('IQD', 3), ('LYD', 3);

CREATE TEMP TABLE rescaled ON COMMIT DROP AS
SELECT a.id, (10::numeric ^ (s.scale - a.scale)) AS factor, s.scale
FROM accounts a
JOIN currency_scales s ON s.currency = a.currency
WHERE s.scale > a.scale;

UPDATE transactions t SET debit = t.debit * r.factor
FROM rescaled r WHERE t.debit_account_id = r.id;

UPDATE transactions t SET credit = t.credit * r.factor
FROM rescaled r WHERE t.credit_account_id = r.id;

UPDATE accounts a SET start_balance = a.start_balance * r.factor, scale = r.scale
FROM rescaled r WHERE a.id = r.id;
