-- 003_create_transactions.sql
CREATE TABLE transactions (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE NOT NULL,
  category_id INTEGER REFERENCES categories(id) ON DELETE RESTRICT,
  debit_account_id INTEGER REFERENCES accounts(id) ON DELETE RESTRICT,
  credit_account_id INTEGER REFERENCES accounts(id) ON DELETE RESTRICT,
  debit NUMERIC(24, 0) NOT NULL,
  credit NUMERIC(24, 0) NOT NULL,
  currency TEXT,
  scale INTEGER NOT NULL DEFAULT 2,
  date DATE NOT NULL,
  description TEXT DEFAULT '',
  payee TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_transactions_user_id ON transactions(user_id);
CREATE INDEX IF NOT EXISTS idx_transactions_date ON transactions(date);
