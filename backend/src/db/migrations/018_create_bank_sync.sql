-- 018_create_bank_sync.sql
-- Direct bank sync through Enable Banking (PSD2).
--
-- bank_credentials: one Enable Banking registration per user. The private key
-- is stored encrypted (AES-256-GCM under the server's BANK_CREDENTIALS_KEY).
CREATE TABLE IF NOT EXISTS bank_credentials (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  application_id TEXT NOT NULL,
  private_key_enc TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- bank_connections: a user's consent with one bank. session_id stays null
-- until the first consent completes; auth_state is the one-time value of a
-- pending consent and is cleared once it is used.
CREATE TABLE IF NOT EXISTS bank_connections (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  aspsp_name TEXT NOT NULL,
  aspsp_country CHAR(2) NOT NULL,
  session_id TEXT,                 -- null until the first consent completes
  valid_until TIMESTAMPTZ,
  expired BOOLEAN NOT NULL DEFAULT false,   -- the bank refused the session
  auth_state TEXT UNIQUE,          -- one-time, null when no consent is pending
  auth_started_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The accounts a session exposes. A reconnect replaces them, and the bank may
-- hand out new uids.
CREATE TABLE IF NOT EXISTS bank_connection_accounts (
  connection_id INTEGER NOT NULL REFERENCES bank_connections(id) ON DELETE CASCADE,
  uid TEXT NOT NULL,
  iban TEXT,
  name TEXT,
  currency TEXT NOT NULL,          -- 'XXX' = multi-currency
  PRIMARY KEY (connection_id, uid)
);

-- Which bank account feeds an app account, and how far it has been loaded.
CREATE TABLE IF NOT EXISTS bank_account_links (
  account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  connection_id INTEGER NOT NULL REFERENCES bank_connections(id) ON DELETE CASCADE,
  uid TEXT NOT NULL,               -- deliberately no FK: survives a reconnect that drops the uid
  loaded_to DATE
);
