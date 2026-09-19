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
};

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

// prices[coinId][vsCurrency], lowercased keys throughout — CoinGecko echoes
// back exactly the lowercase ids and currencies it was asked for.
async function fetchPrices(
  coinIds: string[],
  vsCurrencies: string[]
): Promise<Record<string, Record<string, number>>> {
  const ids = coinIds.join(',');
  const vs = vsCurrencies.join(',').toLowerCase();
  const res = await fetch(`${COINGECKO_BASE_URL}/simple/price?ids=${ids}&vs_currencies=${vs}`, {
    signal: AbortSignal.timeout(COINGECKO_TIMEOUT_MS),
  });

  if (!res.ok) {
    throw new Error(`CoinGecko request failed: ${res.status}`);
  }

  return (await res.json()) as Record<string, Record<string, number>>;
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
    const prices = await fetchPrices([fromCoin, toCoin], ['usd']);
    const fromUsd = priceOf(prices, fromCoin, 'usd');
    const toUsd = priceOf(prices, toCoin, 'usd');
    if (fromUsd === null || toUsd === null) return null;
    return { rate: fromUsd / toUsd, asOf: today() };
  }

  // Coin -> fiat: a direct quote.
  if (fromCoin) {
    const prices = await fetchPrices([fromCoin], [to]);
    const price = priceOf(prices, fromCoin, to);
    if (price === null) return null;
    return { rate: price, asOf: today() };
  }

  // Fiat -> coin: the same quote, inverted.
  if (toCoin) {
    const prices = await fetchPrices([toCoin], [from]);
    const price = priceOf(prices, toCoin, from);
    if (price === null) return null;
    return { rate: 1 / price, asOf: today() };
  }

  // Fiat -> fiat: bridge through the stablecoin quoted in both.
  const prices = await fetchPrices([BRIDGE_COIN], [from, to]);
  const bridgeFrom = priceOf(prices, BRIDGE_COIN, from);
  const bridgeTo = priceOf(prices, BRIDGE_COIN, to);
  if (bridgeFrom === null || bridgeTo === null) return null;
  return { rate: bridgeTo / bridgeFrom, asOf: today() };
}
