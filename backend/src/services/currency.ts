import * as exchangeRateQueries from '../db/queries/exchangeRates';

const FRANKFURTER_BASE_URL = process.env.FRANKFURTER_BASE_URL || 'https://api.frankfurter.dev/v1';
const FRANKFURTER_TIMEOUT_MS = 5000;

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

async function refreshRatesForBase(from: string, toCurrencies: string[]): Promise<void> {
  if (toCurrencies.length === 0) return;
  const symbols = toCurrencies.join(',');
  const res = await fetch(`${FRANKFURTER_BASE_URL}/latest?base=${from}&symbols=${symbols}`, {
    signal: AbortSignal.timeout(FRANKFURTER_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw { statusCode: 502, message: `Frankfurter request failed: ${res.status}` };
  }
  const body = (await res.json()) as { date: string; rates: Record<string, number> };
  for (const [to, rate] of Object.entries(body.rates)) {
    await exchangeRateQueries.upsertRate(from, to, rate, body.date);
  }
}

// Shared cache/refresh/fallback policy for a single currency pair:
// check today's cache -> refresh via Frankfurter on miss -> re-check today's
// cache -> fall back to the latest stale cached rate -> null if nothing exists.
async function getRateInternal(from: string, to: string): Promise<number | null> {
  const cached = await exchangeRateQueries.getRate(from, to, today());
  if (cached) return Number(cached.rate);

  try {
    await refreshRatesForBase(from, [to]);
  } catch (error: unknown) {
    // Network/API failure — log for visibility, then fall through to
    // stale-cache fallback below.
    const message =
      error && typeof error === 'object' && 'message' in error ? error.message : String(error);
    console.error(`Failed to refresh exchange rate ${from}->${to}:`, message);
  }

  const fresh = await exchangeRateQueries.getRate(from, to, today());
  if (fresh) return Number(fresh.rate);

  const stale = await exchangeRateQueries.getLatestRate(from, to);
  return stale ? Number(stale.rate) : null;
}

export async function getOrRefreshRate(from: string, to: string): Promise<number | null> {
  if (from === to) return 1;
  return getRateInternal(from, to);
}

// Batched: resolves all distinct source currencies in parallel (one cache
// lookup and, on a cache miss, one Frankfurter call per distinct source
// currency not already cached for today); returns a Map<fromCurrency, rate|null>.
export async function getRatesTo(
  targetCurrency: string,
  fromCurrencies: string[]
): Promise<Map<string, number | null>> {
  const distinct = [...new Set(fromCurrencies)];

  const entries = await Promise.all(
    distinct.map(async (from): Promise<[string, number | null]> => {
      if (from === targetCurrency) return [from, 1];
      return [from, await getRateInternal(from, targetCurrency)];
    })
  );

  return new Map(entries);
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
