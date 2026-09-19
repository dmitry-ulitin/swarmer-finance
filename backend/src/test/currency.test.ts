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

describe('CoinGecko fallback', () => {
  const originalFetch = global.fetch;

  // Routes by URL so a test can serve Frankfurter and CoinGecko differently:
  // `frankfurter` is the JSON body (or an Error to reject with, or null for a
  // 404 "pair not covered"), `coingecko` is the /simple/price body.
  const mockProviders = (opts: {
    frankfurter?: Record<string, unknown> | Error | null;
    coingecko?: Record<string, Record<string, number>> | Error;
  }) => {
    const fetchMock = jest.fn(async (url: string) => {
      const target = url.includes('coingecko') ? opts.coingecko : opts.frankfurter;
      if (target instanceof Error) throw target;
      if (target === undefined || target === null) {
        return { ok: false, status: 404, json: async () => ({}) };
      }
      return { ok: true, status: 200, json: async () => target };
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  };

  afterEach(async () => {
    global.fetch = originalFetch;
    await pool.query(
      `DELETE FROM exchange_rates
       WHERE from_currency IN ('BTC','USDT','RUB','EUR','ZZZ')
          OR to_currency IN ('BTC','USDT','RUB','ZZZ')`
    );
  });

  it('prices a coin against fiat directly when Frankfurter does not know it', async () => {
    const fetchMock = mockProviders({
      frankfurter: null,
      coingecko: { bitcoin: { eur: 70800 } },
    });

    const rate = await getOrRefreshRate('BTC', 'EUR');

    expect(rate).toBe(70800);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls[1][0]).toContain('ids=bitcoin');
  });

  it('inverts the quote for a fiat -> coin pair', async () => {
    mockProviders({ frankfurter: null, coingecko: { bitcoin: { eur: 50000 } } });

    const rate = await getOrRefreshRate('EUR', 'BTC');

    expect(rate).toBeCloseTo(1 / 50000, 12);
  });

  it('stores a very small rate without collapsing it to zero', async () => {
    // A low-unit-value coin priced in fiat inverts to a rate far below the
    // 10 dp the column originally held; it must survive the round-trip,
    // since a zero would also trip the rate > 0 CHECK constraint.
    mockProviders({ frankfurter: null, coingecko: { tether: { eur: 100000000 } } });

    const rate = await getOrRefreshRate('EUR', 'USDT');

    expect(rate).toBeGreaterThan(0);
    expect(rate).toBeCloseTo(1e-8, 15);
  });

  it('divides USD prices for a coin -> coin pair', async () => {
    mockProviders({
      frankfurter: null,
      coingecko: { bitcoin: { usd: 80000 }, tether: { usd: 1 } },
    });

    const rate = await getOrRefreshRate('BTC', 'USDT');

    expect(rate).toBe(80000);
  });

  it('bridges a fiat -> fiat pair through the stablecoin', async () => {
    mockProviders({
      frankfurter: null,
      coingecko: { tether: { rub: 84.36, eur: 0.87084 } },
    });

    const rate = await getOrRefreshRate('RUB', 'EUR');

    // 1 RUB = (USDT/EUR) / (USDT/RUB) EUR, to the 10 dp the column stores.
    expect(rate).toBeCloseTo(0.87084 / 84.36, 10);
  });

  it('does not call CoinGecko when Frankfurter already covers the pair', async () => {
    const fetchMock = mockProviders({
      frankfurter: { date: new Date().toISOString().slice(0, 10), rates: { EUR: 0.92 } },
      coingecko: { tether: { usd: 1, eur: 0.9 } },
    });

    const rate = await getOrRefreshRate('USD', 'EUR');

    expect(rate).toBe(0.92);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('falls back to CoinGecko when Frankfurter errors rather than 404s', async () => {
    mockProviders({
      frankfurter: new Error('network down'),
      coingecko: { bitcoin: { eur: 71000 } },
    });

    const rate = await getOrRefreshRate('BTC', 'EUR');

    expect(rate).toBe(71000);
  });

  it('returns null when neither provider knows the currency', async () => {
    mockProviders({ frankfurter: null, coingecko: {} });

    const rate = await getOrRefreshRate('ZZZ', 'EUR');

    expect(rate).toBeNull();
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
