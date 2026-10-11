import { TestBed } from '@angular/core/testing';
import { MoneyPipe } from './money.pipe';
import { amountsHint } from './money-hint';

describe('amountsHint', () => {
  const money = () => {
    TestBed.configureTestingModule({ providers: [MoneyPipe] });
    return TestBed.inject(MoneyPipe);
  };

  it('is null for a single amount in the target currency', () => {
    expect(amountsHint(money(), [{ currency: 'USD', scale: 2, amount: 10 }], 'USD')).toBeNull();
  });

  it('shows a single amount in another currency', () => {
    expect(amountsHint(money(), [{ currency: 'RUB', scale: 2, amount: 10 }], 'USD')).toBe('₽10.00');
  });

  it('joins several currencies with a plus', () => {
    expect(amountsHint(money(), [
      { currency: 'USD', scale: 2, amount: 10 },
      { currency: 'RUB', scale: 2, amount: 5 },
    ], 'USD')).toBe('$10.00 + ₽5.00');
  });
});
