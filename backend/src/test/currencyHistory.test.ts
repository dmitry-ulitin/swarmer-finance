import { pool } from '../db';
import { getRatesOn } from '../services/currency';
import { addDays, todayUtc } from '../services/date';

const TARGET = 'CHF';
const SOURCES = ['USD', 'BTC', 'ZZZ'];

// Two month-ends in 2024: 2024-03-29 is a Friday, 2024-03-31 a Sunday,
// 2024-04-30 a Tuesday.
const FRIDAY = '2024-03-29';
const SUNDAY = '2024-03-31';
const APR_END = '2024-04-30';

function routedFetch(routes: { series: string[]; coingecko: unknown }) {
  return jest.fn(async (input: unknown) => {
    const url = String(input);
    if (url.includes('frankfurter') && url.includes('..')) {
      const rates: Record<string, Record<string, number>> = {};
      for (const d of routes.series) rates[d] = { [TARGET]: 0.9 };
      return { ok: true, status: 200, json: async () => ({ rates }) };
    }
    if (url.includes('market_chart/range')) {
      return { ok: true, status: 200, json: async () => routes.coingecko };
    }
    return { ok: false, status: 404, json: async () => ({}) };
  });
}

describe('getRatesOn', () => {
  const originalFetch = global.fetch;

  const clean = () =>
    pool.query(`DELETE FROM exchange_rates WHERE to_currency = $1 AND from_currency = ANY($2)`, [
      TARGET,
      SOURCES,
    ]);
  beforeEach(clean);
  afterEach(async () => {
    global.fetch = originalFetch;
    await clean();
  });

  it('fetches one series for several dates, caches it, and never refetches', async () => {
    const mock = routedFetch({ series: [FRIDAY, '2024-04-29', APR_END], coingecko: {} });
    global.fetch = mock as unknown as typeof fetch;

    const result = await getRatesOn(TARGET, ['USD'], [FRIDAY, APR_END]);
    expect(result.get('USD')!.get(FRIDAY)).toEqual({ rate: 0.9, approximate: false });
    expect(result.get('USD')!.get(APR_END)).toEqual({ rate: 0.9, approximate: false });
    expect(mock).toHaveBeenCalledTimes(1);
    const { rows } = await pool.query(
      `SELECT 1 FROM exchange_rates WHERE from_currency = 'USD' AND to_currency = $1`,
      [TARGET]
    );
    expect(rows.length).toBe(3);

    await getRatesOn(TARGET, ['USD'], [FRIDAY, APR_END]);
    expect(mock).toHaveBeenCalledTimes(1);
  });

  it('uses the preceding weekday for a weekend date as an exact rate', async () => {
    global.fetch = routedFetch({ series: [FRIDAY], coingecko: {} }) as unknown as typeof fetch;
    const result = await getRatesOn(TARGET, ['USD'], [SUNDAY]);
    expect(result.get('USD')!.get(SUNDAY)).toEqual({ rate: 0.9, approximate: false });
  });

  it('does not fetch CoinGecko beyond 364 days and falls back to the nearest rate', async () => {
    const old = addDays(todayUtc(), -400);
    await pool.query(
      `INSERT INTO exchange_rates (from_currency, to_currency, rate, as_of)
       VALUES ('BTC', $1, 50000, $2)`,
      [TARGET, addDays(todayUtc(), -300)]
    );
    const mock = routedFetch({ series: [], coingecko: { prices: [] } });
    global.fetch = mock as unknown as typeof fetch;

    const result = await getRatesOn(TARGET, ['BTC'], [old]);
    expect(result.get('BTC')!.get(old)).toEqual({ rate: 50000, approximate: true });
    expect(
      mock.mock.calls.filter(([u]) => String(u).includes('market_chart/range')).length
    ).toBe(0);
  });

  it('keeps the last CoinGecko price of each UTC day', async () => {
    const day = addDays(todayUtc(), -30);
    const ms = (t: string) => Date.parse(`${day}T${t}Z`);
    global.fetch = routedFetch({
      series: [],
      coingecko: { prices: [[ms('01:00:00'), 100], [ms('23:00:00'), 110]] },
    }) as unknown as typeof fetch;

    const result = await getRatesOn(TARGET, ['BTC'], [day]);
    expect(result.get('BTC')!.get(day)).toEqual({ rate: 110, approximate: false });
  });

  it('returns null for an unknown currency and 1 for the target', async () => {
    global.fetch = routedFetch({ series: [], coingecko: {} }) as unknown as typeof fetch;
    const result = await getRatesOn(TARGET, ['ZZZ', TARGET], [FRIDAY]);
    expect(result.get('ZZZ')!.get(FRIDAY)).toBeNull();
    expect(result.get(TARGET)!.get(FRIDAY)).toEqual({ rate: 1, approximate: false });
  });

  it('survives a failing provider', async () => {
    const err = jest.spyOn(console, 'error').mockImplementation(() => {});
    global.fetch = jest.fn().mockRejectedValue(new Error('down')) as unknown as typeof fetch;
    const result = await getRatesOn(TARGET, ['USD'], [FRIDAY]);
    expect(result.get('USD')!.get(FRIDAY)).toBeNull();
    err.mockRestore();
  });

  it('does not disturb the latest rate', async () => {
    const { getLatestRate } = await import('../db/queries/exchangeRates');
    await pool.query(
      `INSERT INTO exchange_rates (from_currency, to_currency, rate, as_of)
       VALUES ('USD', $1, 0.8, '2030-01-01')`,
      [TARGET]
    );
    global.fetch = routedFetch({ series: [FRIDAY], coingecko: {} }) as unknown as typeof fetch;
    await getRatesOn(TARGET, ['USD'], [FRIDAY]);
    expect((await getLatestRate('USD', TARGET))!.as_of).toBe('2030-01-01');
  });
});
