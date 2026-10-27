import * as userQueries from '../db/queries/users';
import { getCurrencyScale } from './currencyScale';

export interface ProfileUpdate {
  name: string;
  currency: string;
}

/**
 * The currency is only what balances and the summary are converted into, so
 * it can change at any time; its scale follows it, as on registration.
 */
export const updateProfile = async (userId: number, { name, currency }: ProfileUpdate) => {
  const user = await userQueries.updateProfile(userId, name, currency, getCurrencyScale(currency));
  if (!user) {
    throw { statusCode: 401, message: 'User not found' };
  }
  return { id: user.id, email: user.email, name: user.name, currency: user.currency, currency_scale: user.currency_scale };
};
