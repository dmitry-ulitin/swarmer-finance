import { queryOne, execute } from '../index';

export interface ExchangeRateRow {
  from_currency: string;
  to_currency: string;
  rate: string;
  as_of: string;
}

export const getLatestRate = (from: string, to: string) =>
  queryOne<ExchangeRateRow>(
    `SELECT * FROM exchange_rates WHERE from_currency = $1 AND to_currency = $2
     ORDER BY as_of DESC LIMIT 1`,
    [from, to]
  );

// True if the pair's latest cached rate is dated on or after `since` (e.g.
// today's date), or the providers were asked within the last hour — a
// refresh that just returned an older date, or failed, is not retried on
// every request.
export const isRateFresh = async (from: string, to: string, since: string): Promise<boolean> => {
  const result = await queryOne<{ fresh: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM (
         SELECT as_of, checked_at FROM exchange_rates
         WHERE from_currency = $1 AND to_currency = $2
         ORDER BY as_of DESC LIMIT 1
       ) latest
       WHERE latest.as_of >= $3 OR latest.checked_at > now() - interval '1 hour'
     ) AS fresh`,
    [from, to, since]
  );
  return result?.fresh ?? false;
};

/** Records a refresh attempt on the pair's latest row; a no-op when nothing is cached. */
export const markRateChecked = (from: string, to: string) =>
  execute(
    `UPDATE exchange_rates SET checked_at = now()
     WHERE id = (SELECT id FROM exchange_rates WHERE from_currency = $1 AND to_currency = $2
                 ORDER BY as_of DESC LIMIT 1)`,
    [from, to]
  );

export const upsertRate = (from: string, to: string, rate: number, asOf: string) =>
  execute(
    `INSERT INTO exchange_rates (from_currency, to_currency, rate, as_of, checked_at)
     VALUES ($1, $2, $3, $4, now())
     ON CONFLICT (from_currency, to_currency, as_of) DO UPDATE SET rate = EXCLUDED.rate, checked_at = now()`,
    [from, to, rate, asOf]
  );
