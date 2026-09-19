// A demo key raises the rate limit well above the keyless tier's handful of
// requests per minute. Demo keys are served from the public host with an
// x-cg-demo-api-key header; paid keys use pro-api.coingecko.com instead, so
// the host stays overridable.
const COINGECKO_API_KEY = process.env.COINGECKO_API_KEY || '';
const COINGECKO_BASE_URL = process.env.COINGECKO_BASE_URL || 'https://api.coingecko.com/api/v3';
const COINGECKO_TIMEOUT_MS = 5000;

// CoinGecko prices coins by its own id, not by ticker, so every crypto we
// support needs an entry here. Extend as accounts in new coins appear.
const COIN_IDS: Record<string, string> = {
  BTC: 'bitcoin',
  ETH: 'ethereum',
  USDT: 'tether',
  USDC: 'usd-coin',
  SOL: 'solana',
  TON: 'the-open-network',
  TRX: 'tron',
};

// Every request asks for all supported coins rather than just the one the
// pair needs: the response is barely larger, and it makes concurrent
// lookups for different coins collapse into a single shared request.
const ALL_COIN_IDS = Object.values(COIN_IDS);

// Fiat (and metal) codes CoinGecko accepts as `vs_currencies`, from
// /simple/supported_vs_currencies minus the entries that are themselves
// coins. Kept as a literal list so an unsupported pair costs no request.
const VS_CURRENCIES = new Set([
  'AED', 'ARS', 'AUD', 'BDT', 'BHD', 'BMD', 'BRL', 'CAD', 'CHF', 'CLP',
  'CNY', 'CZK', 'DKK', 'EUR', 'GBP', 'GEL', 'HKD', 'HUF', 'IDR', 'ILS',
  'INR', 'JPY', 'KRW', 'KWD', 'LKR', 'MMK', 'MXN', 'MYR', 'NGN', 'NOK',
  'NZD', 'PHP', 'PKR', 'PLN', 'RUB', 'SAR', 'SEK', 'SGD', 'THB', 'TRY',
  'TWD', 'UAH', 'USD', 'VEF', 'VND', 'ZAR', 'XDR', 'XAG', 'XAU',
]);

// CoinGecko only answers "price of a coin in a vs_currency", so a fiat->fiat
// pair (the RUB->EUR case Frankfurter cannot serve) is priced through a
// stablecoin quoted in both. Its crypto-market spread makes such a rate an
// approximation of the official one.
const BRIDGE_COIN = 'tether';

function today(): string {
  return new Date().toISOString().slice(0, 10);
}

// The keyless tier allows only a handful of requests per burst, and
// getRatesTo refreshes every uncached currency in parallel, so a cold cache
// with several crypto accounts reliably draws a 429. Retry just those.
const RETRY_DELAYS_MS = [500, 2000];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// getRatesTo refreshes every uncached currency in parallel, so one page load
// with several crypto accounts used to fire one request per pair and blow
// through the rate limit. Concurrent callers wanting the same coins now
// share a single in-flight request; the entry is dropped as soon as it
// settles, so this coalesces a burst rather than caching across time (the
// exchange_rates table already does the day-long caching).
const inFlight = new Map<string, Promise<Record<string, Record<string, number>>>>();

async function requestPrices(url: string): Promise<Record<string, Record<string, number>>> {
  for (let attempt = 0; ; attempt += 1) {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(COINGECKO_TIMEOUT_MS),
      headers: COINGECKO_API_KEY ? { 'x-cg-demo-api-key': COINGECKO_API_KEY } : {},
    });

    if (res.ok) {
      return (await res.json()) as Record<string, Record<string, number>>;
    }

    // Only 429 is worth retrying: other failures are not going to clear on
    // their own, and CoinGecko sends no Retry-After to pace us by. With
    // requests coalesced this is now a backstop for genuine spikes rather
    // than the load we generate ourselves.
    if (res.status !== 429 || attempt >= RETRY_DELAYS_MS.length) {
      throw new Error(`CoinGecko request failed: ${res.status}`);
    }

    await sleep(RETRY_DELAYS_MS[attempt]);
  }
}

// prices[coinId][vsCurrency], lowercased keys throughout — CoinGecko echoes
// back exactly the lowercase ids and currencies it was asked for.
function fetchPrices(
  coinIds: string[],
  vsCurrencies: string[]
): Promise<Record<string, Record<string, number>>> {
  // Sorted so callers asking for the same set in a different order share one
  // request.
  const ids = [...new Set(coinIds)].sort().join(',');
  const vs = [...new Set(vsCurrencies.map((c) => c.toLowerCase()))].sort().join(',');
  const url = `${COINGECKO_BASE_URL}/simple/price?ids=${ids}&vs_currencies=${vs}`;

  const existing = inFlight.get(url);
  if (existing) return existing;

  const pending = requestPrices(url).finally(() => inFlight.delete(url));
  inFlight.set(url, pending);
  return pending;
}

function priceOf(
  prices: Record<string, Record<string, number>>,
  coinId: string,
  vsCurrency: string
): number | null {
  const price = prices?.[coinId]?.[vsCurrency.toLowerCase()];
  return typeof price === 'number' && price > 0 ? price : null;
}

// Fetches `from`->`to` via CoinGecko, covering the pairs Frankfurter misses:
// crypto on either side, and fiat pairs (such as RUB) bridged through a
// stablecoin. Returns null when either side is a code CoinGecko does not
// know, so the caller can fall through to the stale cache. CoinGecko returns
// no date with a spot price, so the rate is dated today.
export async function fetchRate(
  from: string,
  to: string
): Promise<{ rate: number; asOf: string } | null> {
  const fromCoin = COIN_IDS[from];
  const toCoin = COIN_IDS[to];
  const fromIsFiat = VS_CURRENCIES.has(from);
  const toIsFiat = VS_CURRENCIES.has(to);

  if (!fromCoin && !fromIsFiat) return null;
  if (!toCoin && !toIsFiat) return null;

  // Coin -> coin: price both in USD and divide.
  if (fromCoin && toCoin) {
    const prices = await fetchPrices(ALL_COIN_IDS, ['usd']);
    const fromUsd = priceOf(prices, fromCoin, 'usd');
    const toUsd = priceOf(prices, toCoin, 'usd');
    if (fromUsd === null || toUsd === null) return null;
    return { rate: fromUsd / toUsd, asOf: today() };
  }

  // Coin -> fiat: a direct quote.
  if (fromCoin) {
    const prices = await fetchPrices(ALL_COIN_IDS, [to]);
    const price = priceOf(prices, fromCoin, to);
    if (price === null) return null;
    return { rate: price, asOf: today() };
  }

  // Fiat -> coin: the same quote, inverted.
  if (toCoin) {
    const prices = await fetchPrices(ALL_COIN_IDS, [from]);
    const price = priceOf(prices, toCoin, from);
    if (price === null) return null;
    return { rate: 1 / price, asOf: today() };
  }

  // Fiat -> fiat: bridge through the stablecoin quoted in both.
  const prices = await fetchPrices(ALL_COIN_IDS, [from, to]);
  const bridgeFrom = priceOf(prices, BRIDGE_COIN, from);
  const bridgeTo = priceOf(prices, BRIDGE_COIN, to);
  if (bridgeFrom === null || bridgeTo === null) return null;
  return { rate: bridgeTo / bridgeFrom, asOf: today() };
}
