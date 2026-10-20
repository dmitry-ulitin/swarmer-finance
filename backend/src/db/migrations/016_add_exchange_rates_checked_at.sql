-- When the providers were last asked for this pair. Frankfurter dates a rate
-- by its ECB publication day, so on weekends, holidays and each morning
-- before publication no row is dated today; without this, every request in
-- that window went back to the providers. Set on the pair's latest row by
-- every refresh attempt, successful or not.
ALTER TABLE exchange_rates ADD COLUMN checked_at TIMESTAMP WITH TIME ZONE;
