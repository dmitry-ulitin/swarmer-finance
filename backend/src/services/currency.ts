import * as exchangeRateQueries from '../db/queries/exchangeRates';
import * as frankfurter from './rates/frankfurter';
import * as coingecko from './rates/coingecko';
import { addDays } from './date';

// Tried in order. Frankfurter (ECB rates) is authoritative for the fiat it
// covers; CoinGecko picks up what it does not know — crypto, and fiat such
// as RUB. A provider returning null means "I do not cover this pair", so
// the next one is tried; throwing means the pair looks supported but the
// call failed, which is logged and likewise falls through.
const PROVIDERS = [frankfurter, coingecko];

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Fetch and cache `from`->`to`, trying each provider in turn.
 *
 * A refresh that produces nothing has two quite different causes, and the
 * providers already distinguish them: returning null means "I do not cover
 * this pair", throwing means the pair looks supported but the call failed.
 * Flattening both into silence makes a total upstream outage look exactly
 * like an exotic currency, so each is logged differently — the callers can
 * only fall back to whatever is cached either way, and that fallback is
 * deliberate.
 */
async function refreshRate(from: string, to: string): Promise<void> {
  let failures = 0;
  for (const provider of PROVIDERS) {
    try {
      const result = await provider.fetchRate(from, to);
      if (result) {
        await exchangeRateQueries.upsertRate(from, to, result.rate, result.asOf);
        return;
      }
    } catch (error: unknown) {
      failures++;
      const message =
        error && typeof error === 'object' && 'message' in error ? error.message : String(error);
      console.error(`Failed to refresh exchange rate ${from}->${to}:`, message);
    }
  }

  // Nothing new landed: note the attempt so the next requests serve the
  // cache instead of asking again (see isRateFresh).
  await exchangeRateQueries.markRateChecked(from, to);

  if (failures === PROVIDERS.length) {
    // Nothing answered. Any rate served for this pair now comes from the
    // cache and may be arbitrarily old.
    const latest = await exchangeRateQueries.getLatestRate(from, to);
    console.error(
      `All rate providers failed for ${from}->${to}; ` +
        (latest ? `serving cached rate as of ${latest.as_of}` : 'no cached rate available')
    );
  } else if (failures === 0) {
    console.warn(`No rate provider covers ${from}->${to}`);
  }
}

// Shared cache/refresh/fallback policy for a single currency pair:
// use the latest cached rate if it is dated today or later, or was refreshed
// within the hour -> otherwise refresh via the provider chain -> re-check the
// latest cache -> null if nothing exists. The freshness check is done in SQL
// (isRateFresh).
async function getCachedRate(from: string, to: string): Promise<number | null> {
  if (await exchangeRateQueries.isRateFresh(from, to, today())) {
    const latest = await exchangeRateQueries.getLatestRate(from, to);
    if (latest) return Number(latest.rate);
  }
  return null;
}

async function getRateInternal(from: string, to: string): Promise<number | null> {
  const cached = await getCachedRate(from, to);
  if (cached !== null) return cached;

  await refreshRate(from, to);

  const fresh = await exchangeRateQueries.getLatestRate(from, to);
  return fresh ? Number(fresh.rate) : null;
}

export async function getOrRefreshRate(from: string, to: string): Promise<number | null> {
  if (from === to) return 1;
  return getRateInternal(from, to);
}

// Batched: resolves all distinct source currencies in parallel (one cache
// lookup and, on a cache miss, one provider-chain refresh per distinct
// source currency not already cached for today); returns a
// Map<fromCurrency, rate|null>.
export async function getRatesTo(
  targetCurrency: string,
  fromCurrencies: string[]
): Promise<Map<string, number | null>> {
  const distinct = [...new Set(fromCurrencies)];

  // Every cache lookup finishes before any refresh starts. Interleaving them
  // would stagger the provider calls by a DB round-trip each, which stops
  // concurrent lookups sharing one upstream request and — for a cold cache
  // with several crypto accounts — trips CoinGecko's rate limit.
  const cached = await Promise.all(
    distinct.map(async (from): Promise<[string, number | null]> => {
      if (from === targetCurrency) return [from, 1];
      return [from, await getCachedRate(from, targetCurrency)];
    })
  );

  const entries = await Promise.all(
    cached.map(async ([from, rate]): Promise<[string, number | null]> => {
      if (rate !== null) return [from, rate];
      // Straight to the providers — the cache was just checked above, and a
      // second lookup here would re-stagger the calls we are coalescing.
      await refreshRate(from, targetCurrency);
      const fresh = await exchangeRateQueries.getLatestRate(from, targetCurrency);
      return [from, fresh ? Number(fresh.rate) : null];
    })
  );

  return new Map(entries);
}

export type HistoricalRate = { rate: number; approximate: boolean } | null;

const EXACT_WINDOW_DAYS = 6;

// Fetches the day rates for `from`->`to` over start..end with the first
// provider that has them, and caches each. A throwing provider is logged and
// the next one tried.
async function fetchSeriesInto(from: string, to: string, start: string, end: string) {
  for (const provider of PROVIDERS) {
    try {
      const series = await provider.fetchSeries(from, to, start, end);
      if (series) {
        for (const { date, rate } of series) {
          await exchangeRateQueries.upsertRate(from, to, rate, date);
        }
        return;
      }
    } catch (error: unknown) {
      const message =
        error && typeof error === 'object' && 'message' in error ? error.message : String(error);
      console.error(`Failed to fetch exchange rate history ${from}->${to}:`, message);
    }
  }
}

/**
 * Rates `currency -> target` on each date, by currency then date. A cached
 * rate within the 6 days up to the date is exact (the ECB skips weekends);
 * otherwise the nearest cached rate is used with `approximate: true`; null
 * when the pair has none. Dates without an exact rate cost one series fetch
 * per currency over their span; cached dates are never refetched.
 */
export async function getRatesOn(
  target: string,
  currencies: string[],
  dates: string[]
): Promise<Map<string, Map<string, HistoricalRate>>> {
  const result = new Map<string, Map<string, HistoricalRate>>();
  const sorted = [...new Set(dates)].sort();

  for (const currency of new Set(currencies)) {
    const byDate = new Map<string, HistoricalRate>();
    result.set(currency, byDate);
    if (currency === target) {
      for (const d of sorted) byDate.set(d, { rate: 1, approximate: false });
      continue;
    }
    if (sorted.length === 0) continue;

    const load = () =>
      exchangeRateQueries.getRatesBetween(
        currency,
        target,
        addDays(sorted[0], -EXACT_WINDOW_DAYS),
        sorted[sorted.length - 1]
      );
    const exactOn = (rows: { as_of: string; rate: number }[], d: string) => {
      const from = addDays(d, -EXACT_WINDOW_DAYS);
      for (let i = rows.length - 1; i >= 0; i--) {
        if (rows[i].as_of <= d) return rows[i].as_of >= from ? rows[i] : undefined;
      }
      return undefined;
    };

    let rows = await load();
    const missing = sorted.filter((d) => !exactOn(rows, d));
    if (missing.length > 0) {
      await fetchSeriesInto(
        currency,
        target,
        addDays(missing[0], -EXACT_WINDOW_DAYS),
        missing[missing.length - 1]
      );
      rows = await load();
    }

    // Nearest-row fallback needs rows outside the exact window too.
    let all: { as_of: string; rate: number }[] | null = null;
    for (const d of sorted) {
      const exact = exactOn(rows, d);
      if (exact) {
        byDate.set(d, { rate: exact.rate, approximate: false });
        continue;
      }
      all ??= await exchangeRateQueries.getRatesBetween(currency, target, '0001-01-01', '9999-12-31');
      let best: { as_of: string; rate: number } | null = null;
      let bestDist = Infinity;
      for (const r of all) {
        const dist = Math.abs(Date.parse(r.as_of) - Date.parse(d));
        if (dist < bestDist) {
          best = r;
          bestDist = dist;
        }
      }
      byDate.set(d, best ? { rate: best.rate, approximate: true } : null);
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

export function toDecimal(amountCents: number, scale: number): number {
  return amountCents / 10 ** scale;
}

export function toCents(amountDecimal: number, scale: number): number {
  return Math.round(amountDecimal * 10 ** scale);
}
