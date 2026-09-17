-- Per-account access grants. The owner is NOT stored here: accounts.user_id
-- remains the single source of ownership, and services/access.ts supplies the
-- owner level itself. Storing an owner row would create a second source of
-- truth that can be deleted, leaving an account with no owner.
CREATE TABLE IF NOT EXISTS account_shares (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  user_id    INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  level      INTEGER NOT NULL CHECK (level IN (1, 2, 3)),
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (account_id, user_id)
);

-- Every request asks "which accounts can this user reach".
CREATE INDEX IF NOT EXISTS idx_account_shares_user_id ON account_shares(user_id);
