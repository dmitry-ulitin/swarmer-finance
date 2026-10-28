ALTER TABLE accounts DROP CONSTRAINT chk_accounts_type;
ALTER TABLE accounts
  ADD CONSTRAINT chk_accounts_type
  CHECK (type IN ('cash', 'bank', 'crypto', 'investment', 'property', 'deposit'));

CREATE TABLE account_valuations (
  id SERIAL PRIMARY KEY,
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  as_of DATE NOT NULL,
  value NUMERIC(24, 0) NOT NULL,
  user_id INTEGER NOT NULL REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (account_id, as_of)
);

CREATE TABLE account_user_settings (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  in_net_worth BOOLEAN NOT NULL,
  PRIMARY KEY (account_id, user_id)
);
