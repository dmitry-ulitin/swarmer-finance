ALTER TABLE accounts
  ADD COLUMN type TEXT NOT NULL DEFAULT 'cash',
  ADD COLUMN settings JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE accounts
  ADD CONSTRAINT chk_accounts_type
  CHECK (type IN ('cash', 'bank', 'crypto'));
