import { describe, it, expect } from 'vitest';
import { gainPct } from './account-gain';

describe('gainPct', () => {
  it('is the percentage gain over the invested amount', () => {
    expect(gainPct({ balance: 1300, invested: 1000, last_valuation_date: '2026-10-01' })).toBe(30);
  });

  it('is negative on a loss', () => {
    expect(gainPct({ balance: 950, invested: 1000, last_valuation_date: '2026-10-01' })).toBe(-5);
  });

  it('is null without a valuation', () => {
    expect(gainPct({ balance: 1300, invested: 1000, last_valuation_date: null })).toBeNull();
  });

  it('is null when nothing is invested', () => {
    expect(gainPct({ balance: 100, invested: 0, last_valuation_date: '2026-10-01' })).toBeNull();
  });
});
