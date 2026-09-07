import { queryOne, execute } from '../index';

export interface ExchangeRateRow {
  from_currency: string;
  to_currency: string;
  rate: string;
  as_of: string;
}

export const getRate = (from: string, to: string, asOf: string) =>
  queryOne<ExchangeRateRow>(
    `SELECT * FROM exchange_rates WHERE from_currency = $1 AND to_currency = $2 AND as_of = $3`,
    [from, to, asOf]
  );

export const getLatestRate = (from: string, to: string) =>
  queryOne<ExchangeRateRow>(
    `SELECT * FROM exchange_rates WHERE from_currency = $1 AND to_currency = $2
     ORDER BY as_of DESC LIMIT 1`,
    [from, to]
  );

export const upsertRate = (from: string, to: string, rate: number, asOf: string) =>
  execute(
    `INSERT INTO exchange_rates (from_currency, to_currency, rate, as_of)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (from_currency, to_currency, as_of) DO UPDATE SET rate = EXCLUDED.rate`,
    [from, to, rate, asOf]
  );
