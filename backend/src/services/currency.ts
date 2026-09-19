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

async function refreshRate(from: string, to: string): Promise<void> {
  for (const provider of PROVIDERS) {
    try {
      const result = await provider.fetchRate(from, to);
      if (result) {
        await exchangeRateQueries.upsertRate(from, to, result.rate, result.asOf);
        return;
      }
    } catch (error: unknown) {
      const message =
        error && typeof error === 'object' && 'message' in error ? error.message : String(error);
      console.error(`Failed to refresh exchange rate ${from}->${to}:`, message);
    }
  }
}

// Shared cache/refresh/fallback policy for a single currency pair:
// use the latest cached rate if any row is dated today or later -> otherwise
// refresh via the provider chain -> re-check the latest cache -> null if
// nothing exists. The freshness check is done in SQL (hasRateSince) rather
// than by pulling as_of into JS and comparing, since pg returns DATE columns
// as Date objects that shift with the local timezone, not the plain date
// string they were stored as.
async function getRateInternal(from: string, to: string): Promise<number | null> {
  if (await exchangeRateQueries.hasRateSince(from, to, today())) {
    const latest = await exchangeRateQueries.getLatestRate(from, to);
    if (latest) return Number(latest.rate);
  }

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

export function toDecimal(amountCents: number, scale: number): number {
  return amountCents / 10 ** scale;
}

export function toCents(amountDecimal: number, scale: number): number {
  return Math.round(amountDecimal * 10 ** scale);
}
