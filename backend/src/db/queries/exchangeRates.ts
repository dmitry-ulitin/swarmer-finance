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

// True if the latest cached rate for this pair is dated on or after `since`
// (e.g. today's date) — used to decide whether a Frankfurter refresh is
// needed.
export const hasRateSince = async (from: string, to: string, since: string): Promise<boolean> => {
  const result = await queryOne<{ exists: boolean }>(
    `SELECT EXISTS(
       SELECT 1 FROM exchange_rates
       WHERE from_currency = $1 AND to_currency = $2 AND as_of >= $3
     ) AS exists`,
    [from, to, since]
  );
  return result?.exists ?? false;
};

export const upsertRate = (from: string, to: string, rate: number, asOf: string) =>
  execute(
    `INSERT INTO exchange_rates (from_currency, to_currency, rate, as_of)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (from_currency, to_currency, as_of) DO UPDATE SET rate = EXCLUDED.rate`,
    [from, to, rate, asOf]
  );
