// ISO 4217 minor-unit exceptions. Any currency not listed here defaults to 2
// decimal places (the minor unit for the overwhelming majority of currencies).
const ZERO_DECIMAL_CURRENCIES = new Set([
  'JPY', 'KRW', 'VND', 'CLP', 'ISK', 'HUF', 'TWD', 'UGX', 'PYG', 'RWF',
  'VUV', 'XOF', 'XAF', 'XPF', 'GNF', 'BIF', 'DJF', 'KMF', 'MGA',
]);

const THREE_DECIMAL_CURRENCIES = new Set([
  'BHD', 'JOD', 'KWD', 'OMR', 'TND', 'IQD', 'LYD',
]);

export function getCurrencyScale(currency: string): number {
  if (ZERO_DECIMAL_CURRENCIES.has(currency)) return 0;
  if (THREE_DECIMAL_CURRENCIES.has(currency)) return 3;
  return 2;
}
