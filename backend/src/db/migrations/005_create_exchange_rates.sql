CREATE TABLE IF NOT EXISTS exchange_rates (
  id SERIAL PRIMARY KEY,
  from_currency TEXT NOT NULL,
  to_currency TEXT NOT NULL,
  rate NUMERIC(20, 10) NOT NULL,
  as_of DATE NOT NULL,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT CURRENT_TIMESTAMP
);

ALTER TABLE exchange_rates
  ADD CONSTRAINT chk_exchange_rates_currency_format
  CHECK (from_currency ~ '^[A-Z]{3,4}$' AND to_currency ~ '^[A-Z]{3,4}$');

ALTER TABLE exchange_rates
  ADD CONSTRAINT chk_exchange_rates_rate_positive
  CHECK (rate > 0);

CREATE UNIQUE INDEX IF NOT EXISTS uq_exchange_rates_pair_date
  ON exchange_rates (from_currency, to_currency, as_of);
