import * as accountQueries from '../db/queries/accounts';

export const getAccounts = async (userId: number) => {
  return accountQueries.getAccountsByUserId(userId);
};

export const createAccount = async (
  userId: number,
  name: string,
  currency: string,
  startBalance: number
) => {
  return accountQueries.createAccount(userId, name, currency, startBalance);
};

export const updateAccount = async (
  id: number,
  userId: number,
  data: { name?: string; currency?: string; startBalance?: number }
) => {
  const existing = await accountQueries.getAccountById(id, userId);
  if (!existing) {
    throw { statusCode: 404, message: 'Account not found' };
  }
  return accountQueries.updateAccount(id, userId, data);
};

export const deleteAccount = async (id: number, userId: number): Promise<void> => {
  const existing = await accountQueries.getAccountById(id, userId);
  if (!existing) {
    throw { statusCode: 404, message: 'Account not found' };
  }
  await accountQueries.deleteAccount(id, userId);
};
