import type { Account } from '../models/account';

/** Percentage gain of an account's value over what was invested; null without a valuation or investment. */
export function gainPct(
  account: Pick<Account, 'balance' | 'invested' | 'last_valuation_date'>
): number | null {
  const invested = account.invested ?? 0;
  if (!account.last_valuation_date || invested <= 0) return null;
  return ((account.balance - invested) / invested) * 100;
}
