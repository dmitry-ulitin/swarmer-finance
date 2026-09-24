// ISO 4217 minor-unit exceptions. Any currency not listed here defaults to 2
// decimal places (the minor unit for the overwhelming majority of currencies).
const ZERO_DECIMAL_CURRENCIES = new Set([
  'JPY', 'KRW', 'VND', 'CLP', 'ISK', 'HUF', 'TWD', 'UGX', 'PYG', 'RWF',
  'VUV', 'XOF', 'XAF', 'XPF', 'GNF', 'BIF', 'DJF', 'KMF', 'MGA',
]);

const THREE_DECIMAL_CURRENCIES = new Set([
  'BHD', 'JOD', 'KWD', 'OMR', 'TND', 'IQD', 'LYD',
]);

// Crypto has no ISO minor unit. BTC's satoshi is 8 decimals; ETH's native
// 18 is capped at 8 because amounts cross the API as JS numbers, which hold
// only ~15 significant digits. Mirrored in frontend/src/app/core/currency-scale.ts.
const CRYPTO_SCALES: Record<string, number> = {
  BTC: 8, ETH: 8, USDT: 6, USDC: 6, SOL: 9, TON: 9, TRX: 6,
};

export function getCurrencyScale(currency: string): number {
  if (currency in CRYPTO_SCALES) return CRYPTO_SCALES[currency];
  if (ZERO_DECIMAL_CURRENCIES.has(currency)) return 0;
  if (THREE_DECIMAL_CURRENCIES.has(currency)) return 3;
  return 2;
}
