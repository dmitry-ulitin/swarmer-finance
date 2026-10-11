import { MoneyPipe } from './money.pipe';

export interface MoneyAmount {
  currency: string;
  scale: number;
  amount: number;
}

/**
 * The unconverted amounts behind a total in `currency`, for a hint — or null
 * when they say nothing the total does not (a single amount in that currency).
 */
export function amountsHint(money: MoneyPipe, amounts: MoneyAmount[], currency: string): string | null {
  if (amounts.length === 1 && amounts[0].currency === currency) return null;
  return amounts.map(a => money.transform(a.amount, a.currency, a.scale)).join(' + ');
}
