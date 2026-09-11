import * as accountQueries from '../db/queries/accounts';
import * as userQueries from '../db/queries/users';
import { getAccountBalances } from '../db/queries/transactions';
import { getRatesTo, convertAmount } from './currency';
import { Account, User } from '../types';

async function withBalances(userId: number, accounts: Account[]): Promise<Account[]> {
  const rows = await getAccountBalances(userId, accounts.map(a => a.id));
  return accounts.map(account => {
    let balance = Number(account.start_balance);
    for (const row of rows) {
      if (row.credit_account_id === account.id) balance += row.credit;
      if (row.debit_account_id === account.id) balance -= row.debit;
    }
    return { ...account, balance };
  });
}

async function getUserOrThrow(userId: number): Promise<User> {
  const user = await userQueries.getUserById(userId);
  if (!user) {
    throw { statusCode: 401, message: 'User not found' };
  }
  return user;
}

async function withConvertedBalances(user: User, accounts: Account[]): Promise<Account[]> {
  const rates = await getRatesTo(user.currency, accounts.map(a => a.currency));
  return accounts.map(account => {
    const rate = rates.get(account.currency) ?? null;
    const userBalance = convertAmount(account.balance, account.scale, rate, user.currency_scale);
    return { ...account, user_balance: userBalance };
  });
}

export const getAccounts = async (userId: number) => {
  const user = await getUserOrThrow(userId);
  const accounts = await accountQueries.getAccountsByUserId(userId);
  const withBal = await withBalances(userId, accounts);
  return withConvertedBalances(user, withBal);
};

export const createAccount = async (
  userId: number,
  name: string,
  currency: string,
  startBalance: number,
  scale = 2
) => {
  const user = await getUserOrThrow(userId);
  const account = await accountQueries.createAccount(userId, name, currency, startBalance, scale);
  return (await withConvertedBalances(user, [{ ...account, balance: Number(account.start_balance) }]))[0];
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
  if (existing.deleted) {
    throw { statusCode: 404, message: 'Account is deleted' };
  }
  const user = await getUserOrThrow(userId);
  const account = await accountQueries.updateAccount(id, userId, data);
  const [withBal] = await withBalances(userId, [account!]);
  return (await withConvertedBalances(user, [withBal]))[0];
};

/**
 * Delete an account using a 3-state policy:
 *
 *   1. No transactions referencing the account → hard DELETE
 *   2. Transactions exist and balance is zero → soft DELETE (deleted = true)
 *   3. Transactions exist and balance is non-zero → 409 Conflict
 *
 * Soft-deleted accounts are hidden from the accounts list UI, but
 * remain visible elsewhere (e.g. when editing existing transactions
 * that reference them) and their transaction history stays intact for
 * audit purposes. Operations that would change a soft-deleted
 * account's balance (creating/updating a transaction against it) must
 * be rejected. The FK from
 * transactions.{debit,credit}_account_id to accounts.id is RESTRICT
 * (migration 004) — that is why we cannot simply hard-delete accounts
 * with transactions attached.
 *
 * Returns one of: { kind: 'hard-deleted' }, { kind: 'soft-deleted' },
 * or throws an HttpError with statusCode: 409 / 404.
 */
export const deleteAccount = async (
  id: number,
  userId: number
): Promise<{ kind: 'hard-deleted' | 'soft-deleted' }> => {
  // Include-deleted lookup so an already-deleted account reports 404
  // rather than being silently re-soft-deleted.
  const existing = await accountQueries.getAccountById(id, userId);
  if (!existing) {
    throw { statusCode: 404, message: 'Account not found' };
  }
  if (existing.deleted) {
    throw { statusCode: 404, message: 'Account is deleted' };
  }

  const hasTx = await accountQueries.hasTransactions(id);

  if (!hasTx) {
    // Foreign keys (transactions.debit_account_id / credit_account_id
    // use ON DELETE RESTRICT, migration 004) guarantee that an account
    // with zero transactions can be hard-deleted without affecting any
    // history.
    const ok = await accountQueries.hardDeleteAccount(id, userId);
    if (!ok) {
      throw { statusCode: 404, message: 'Account not found' };
    }
    return { kind: 'hard-deleted' };
  }

  // Transactions exist — check balance.
  const [accountWithBalance] = await withBalances(userId, [existing]);
  const balance = accountWithBalance.balance;

  if (balance !== 0) {
    throw {
      statusCode: 409,
      message: `Account has a non-zero balance (${balance}) and transactions; cannot delete`,
    };
  }

  // Balance is zero — soft delete.
  const ok = await accountQueries.softDeleteAccount(id, userId);
  if (!ok) {
    throw { statusCode: 404, message: 'Account not found' };
  }
  return { kind: 'soft-deleted' };
};