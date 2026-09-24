// Decimal places per currency. Mirrors backend/src/services/currencyScale.ts,
// which is the authority: it sets an account's scale. The form only needs it
// to offer the right precision before the account exists.
const ZERO_DECIMAL = new Set([
  'JPY', 'KRW', 'VND', 'CLP', 'ISK', 'HUF', 'TWD', 'UGX', 'PYG', 'RWF',
  'VUV', 'XOF', 'XAF', 'XPF', 'GNF', 'BIF', 'DJF', 'KMF', 'MGA',
]);
const THREE_DECIMAL = new Set(['BHD', 'JOD', 'KWD', 'OMR', 'TND', 'IQD', 'LYD']);
const CRYPTO: Record<string, number> = { BTC: 8, ETH: 8, USDT: 6, USDC: 6, SOL: 9, TON: 9, TRX: 6 };

export function currencyScale(currency: string): number {
  if (currency in CRYPTO) return CRYPTO[currency];
  if (ZERO_DECIMAL.has(currency)) return 0;
  if (THREE_DECIMAL.has(currency)) return 3;
  return 2;
}
