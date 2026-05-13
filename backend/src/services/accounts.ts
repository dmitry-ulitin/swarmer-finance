import * as accountQueries from '../db/queries/accounts';
import { getAccountBalances } from '../db/queries/transactions';
import { Account } from '../types';

async function withBalances(userId: number, accounts: Account[]): Promise<Account[]> {
  const rows = await getAccountBalances(userId, []);
  return accounts.map(account => {
    let balance = Number(account.start_balance);
    for (const row of rows) {
      if (row.credit_account_id === account.id) balance += row.credit;
      if (row.debit_account_id === account.id) balance -= row.debit;
    }
    return { ...account, balance };
  });
}

export const getAccounts = async (userId: number) => {
  const accounts = await accountQueries.getAccountsByUserId(userId);
  return withBalances(userId, accounts);
};

export const createAccount = async (
  userId: number,
  name: string,
  currency: string,
  startBalance: number,
  scale = 2
) => {
  const account = await accountQueries.createAccount(userId, name, currency, startBalance, scale);
  return { ...account, balance: Number(account.start_balance) };
};

export const updateAccount = async (
  id: number,
  userId: number,
  data: { name?: string; currency?: string; startBalance?: number; scale?: number }
) => {
  const existing = await accountQueries.getAccountById(id, userId);
  if (!existing) {
    throw { statusCode: 404, message: 'Account not found' };
  }
  const account = await accountQueries.updateAccount(id, userId, data);
  return (await withBalances(userId, [account!]))[0];
};

export const deleteAccount = async (id: number, userId: number): Promise<void> => {
  const existing = await accountQueries.getAccountById(id, userId);
  if (!existing) {
    throw { statusCode: 404, message: 'Account not found' };
  }
  await accountQueries.deleteAccount(id, userId);
};
