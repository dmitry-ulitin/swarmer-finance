import * as exchangeRateQueries from '../db/queries/exchangeRates';
import * as frankfurter from './rates/frankfurter';
import * as coingecko from './rates/coingecko';

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
// use the latest cached rate if any row is dated today or later -> otherwise
// refresh via the provider chain -> re-check the latest cache -> null if
// nothing exists. The freshness check is done in SQL (hasRateSince).
async function getCachedRate(from: string, to: string): Promise<number | null> {
  if (await exchangeRateQueries.hasRateSince(from, to, today())) {
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
