import { describe, it, expect } from 'vitest';
import { currencyScale } from './currency-scale';

describe('currencyScale', () => {
  it.each([
    ['EUR', 2], ['JPY', 0], ['KWD', 3],
    ['BTC', 8], ['ETH', 8], ['USDT', 6], ['SOL', 9],
  ])('%s has %i decimals', (currency, scale) => {
    expect(currencyScale(currency as string)).toBe(scale);
  });
});
