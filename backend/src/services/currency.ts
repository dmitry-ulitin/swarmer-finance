import * as exchangeRateQueries from '../db/queries/exchangeRates';

const FRANKFURTER_BASE_URL = process.env.FRANKFURTER_BASE_URL || 'https://api.frankfurter.dev/v1';

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function refreshRatesForBase(from: string, toCurrencies: string[]): Promise<void> {
  if (toCurrencies.length === 0) return;
  const symbols = toCurrencies.join(',');
  const res = await fetch(`${FRANKFURTER_BASE_URL}/latest?base=${from}&symbols=${symbols}`);
  if (!res.ok) {
    throw { statusCode: 502, message: `Frankfurter request failed: ${res.status}` };
  }
  const body = (await res.json()) as { date: string; rates: Record<string, number> };
  for (const [to, rate] of Object.entries(body.rates)) {
    await exchangeRateQueries.upsertRate(from, to, rate, body.date);
  }
}

export async function getOrRefreshRate(from: string, to: string): Promise<number | null> {
  if (from === to) return 1;

  const cached = await exchangeRateQueries.getRate(from, to, today());
  if (cached) return Number(cached.rate);

  try {
    await refreshRatesForBase(from, [to]);
  } catch {
    // Network/API failure — fall through to stale-cache fallback below.
  }

  const fresh = await exchangeRateQueries.getRate(from, to, today());
  if (fresh) return Number(fresh.rate);

  const stale = await exchangeRateQueries.getLatestRate(from, to);
  return stale ? Number(stale.rate) : null;
}

// Batched: one Frankfurter call per distinct source currency not already
// cached for today; returns a Map<fromCurrency, rate|null>.
export async function getRatesTo(
  targetCurrency: string,
  fromCurrencies: string[]
): Promise<Map<string, number | null>> {
  const distinct = [...new Set(fromCurrencies)];
  const result = new Map<string, number | null>();
  const needsFetch: string[] = [];

  for (const from of distinct) {
    if (from === targetCurrency) {
      result.set(from, 1);
      continue;
    }
    const cached = await exchangeRateQueries.getRate(from, targetCurrency, today());
    if (cached) {
      result.set(from, Number(cached.rate));
    } else {
      needsFetch.push(from);
    }
  }

  for (const from of needsFetch) {
    try {
      await refreshRatesForBase(from, [targetCurrency]);
      const fresh = await exchangeRateQueries.getRate(from, targetCurrency, today());
      result.set(from, fresh ? Number(fresh.rate) : null);
    } catch {
      const stale = await exchangeRateQueries.getLatestRate(from, targetCurrency);
      result.set(from, stale ? Number(stale.rate) : null);
    }
  }

  return result;
}

export function convertAmount(
  amount: number,
  fromScale: number,
  rate: number | null,
  toScale: number
): number | null {
  if (rate === null) return null;
  const fromMajor = amount / 10 ** fromScale;
  const toMajor = fromMajor * rate;
  return Math.round(toMajor * 10 ** toScale);
}
