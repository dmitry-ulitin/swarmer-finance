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

/**
 * Delete an account using a 3-state policy:
 *
 *   1. No transactions referencing the account → hard DELETE
 *   2. Transactions exist and balance is zero → soft DELETE (deleted = true)
 *   3. Transactions exist and balance is non-zero → 409 Conflict
 *
 * Soft-deleted accounts are hidden from read paths (getAccounts,
 * getAccountById filter `deleted = false`) but their transaction
 * history stays intact for audit purposes. The FK from
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
  const existing = await accountQueries.getAccountByIdIncludingDeleted(id, userId);
  if (!existing) {
    throw { statusCode: 404, message: 'Account not found' };
  }
  if (existing.deleted) {
    throw { statusCode: 404, message: 'Account not found' };
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