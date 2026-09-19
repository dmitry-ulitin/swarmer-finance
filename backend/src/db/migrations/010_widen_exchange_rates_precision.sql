-- NUMERIC(20, 10) was sized for fiat pairs, whose rates sit within a few
-- orders of magnitude of 1. Crypto breaks that assumption in both
-- directions: BTC -> fiat runs into the millions, while fiat -> a
-- low-unit-value coin inverts to well below 1e-10, which truncated to zero
-- and then tripped the rate > 0 CHECK constraint.
ALTER TABLE exchange_rates
  ALTER COLUMN rate TYPE NUMERIC(30, 20);
