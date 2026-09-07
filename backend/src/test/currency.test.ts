import { pool } from '../db';
import { convertAmount, getOrRefreshRate, getRatesTo } from '../services/currency';

describe('getOrRefreshRate', () => {
  const originalFetch = global.fetch;

  afterEach(async () => {
    global.fetch = originalFetch;
    await pool.query(
      `DELETE FROM exchange_rates WHERE from_currency IN ('USD','GBP','XYZ') AND to_currency = 'EUR'`
    );
  });

  it('returns 1 for a same-currency pair without hitting fetch', async () => {
    global.fetch = jest.fn();
    const rate = await getOrRefreshRate('EUR', 'EUR');
    expect(rate).toBe(1);
    expect(global.fetch).not.toHaveBeenCalled();
  });

  it('fetches and caches a rate on first request, then reuses the cache', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ date: new Date().toISOString().slice(0, 10), rates: { EUR: 0.92 } }),
    }) as unknown as typeof fetch;

    const rate = await getOrRefreshRate('USD', 'EUR');
    expect(rate).toBe(0.92);
    expect(global.fetch).toHaveBeenCalledTimes(1);

    const rate2 = await getOrRefreshRate('USD', 'EUR');
    expect(rate2).toBe(0.92);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  it('falls back to a stale cached rate when Frankfurter is unreachable', async () => {
    await pool.query(
      `INSERT INTO exchange_rates (from_currency, to_currency, rate, as_of)
       VALUES ('GBP', 'EUR', 1.17, '2020-01-01')
       ON CONFLICT (from_currency, to_currency, as_of) DO UPDATE SET rate = EXCLUDED.rate`
    );
    global.fetch = jest.fn().mockRejectedValue(new Error('network down'));

    const rate = await getOrRefreshRate('GBP', 'EUR');
    expect(rate).toBe(1.17);
  });

  it('returns null when unreachable and no cache exists at all', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('network down'));
    const rate = await getOrRefreshRate('XYZ', 'EUR');
    expect(rate).toBeNull();
  });
});

describe('refreshRatesForBase — request timeout', () => {
  const originalFetch = global.fetch;

  afterEach(async () => {
    global.fetch = originalFetch;
    await pool.query(`DELETE FROM exchange_rates WHERE from_currency = 'TMO' AND to_currency = 'EUR'`);
  });

  it('calls fetch with an AbortSignal (so a hung Frankfurter request can be aborted)', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ date: new Date().toISOString().slice(0, 10), rates: { EUR: 0.5 } }),
    }) as unknown as typeof fetch;

    await getOrRefreshRate('TMO', 'EUR');

    expect(global.fetch).toHaveBeenCalledTimes(1);
    const [, init] = (global.fetch as jest.Mock).mock.calls[0];
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('falls back to a stale cached rate when the request times out', async () => {
    await pool.query(
      `INSERT INTO exchange_rates (from_currency, to_currency, rate, as_of)
       VALUES ('TMO', 'EUR', 2.5, '2020-01-01')
       ON CONFLICT (from_currency, to_currency, as_of) DO UPDATE SET rate = EXCLUDED.rate`
    );
    global.fetch = jest.fn().mockRejectedValue(new DOMException('The operation was aborted', 'TimeoutError'));

    const rate = await getOrRefreshRate('TMO', 'EUR');
    expect(rate).toBe(2.5);
  });
});

describe('getRatesTo', () => {
  const originalFetch = global.fetch;

  afterEach(async () => {
    global.fetch = originalFetch;
    await pool.query(`DELETE FROM exchange_rates WHERE from_currency = 'USD' AND to_currency = 'EUR'`);
  });

  it('dedupes distinct source currencies and short-circuits the target currency to rate 1', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ date: new Date().toISOString().slice(0, 10), rates: { EUR: 0.92 } }),
    }) as unknown as typeof fetch;

    const rates = await getRatesTo('EUR', ['USD', 'USD', 'EUR']);

    expect(rates.get('USD')).toBe(0.92);
    expect(rates.get('EUR')).toBe(1);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });
});

describe('convertAmount', () => {
  it('converts cents across currencies using the rate', () => {
    // 10000 cents USD (=$100) at rate 0.92 -> 9200 cents EUR (=€92)
    expect(convertAmount(10000, 2, 0.92, 2)).toBe(9200);
  });

  it('returns null when rate is null', () => {
    expect(convertAmount(10000, 2, null, 2)).toBeNull();
  });

  it('handles a target scale different from the source scale', () => {
    // 10000 cents USD (=$100) at rate 1 -> scale 4 -> 1000000
    expect(convertAmount(10000, 2, 1, 4)).toBe(1000000);
  });
});
