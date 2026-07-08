import { query, queryOne, execute } from '../index';
import { Account } from '../../types';

export const getAccountsByUserId = async (userId: number): Promise<Account[]> => {
  return query<Account>(
    'SELECT * FROM accounts WHERE user_id = $1 AND deleted = false ORDER BY name',
    [userId]
  );
};

export const getAccountById = async (id: number, userId: number): Promise<Account | null> => {
  return queryOne<Account>(
    'SELECT * FROM accounts WHERE id = $1 AND user_id = $2 AND deleted = false',
    [id, userId]
  );
};

/**
 * Lookup that ignores the soft-delete flag. Used by the service-layer
 * pre-delete check to know whether the row still exists (and to
 * distinguish 404 from "already deleted").
 */
export const getAccountByIdIncludingDeleted = async (
  id: number,
  userId: number
): Promise<Account | null> => {
  return queryOne<Account>(
    'SELECT * FROM accounts WHERE id = $1 AND user_id = $2',
    [id, userId]
  );
};

export const createAccount = async (
  userId: number,
  name: string,
  currency: string,
  startBalance: number,
  scale: number
): Promise<Account> => {
  const result = await query<Account>(
    `INSERT INTO accounts (user_id, name, currency, start_balance, scale)
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [userId, name, currency, startBalance, scale]
  );
  return result[0];
};

export const updateAccount = async (
  id: number,
  userId: number,
  data: { name?: string; currency?: string; startBalance?: number; scale?: number }
): Promise<Account | null> => {
  const result = await query<Account>(
    `UPDATE accounts
     SET name = COALESCE($1, name),
         currency = COALESCE($2, currency),
         start_balance = COALESCE($3, start_balance),
         scale = COALESCE($4, scale)
     WHERE id = $5 AND user_id = $6 AND deleted = false RETURNING *`,
    [data.name ?? null, data.currency ?? null, data.startBalance ?? null, data.scale ?? null, id, userId]
  );
  return result[0] || null;
};

/**
 * Returns true if any transaction references the given account.
 * Used by the deleteAccount service to choose between hard delete
 * (no transactions) and soft delete (transactions exist).
 */
export const hasTransactions = async (accountId: number): Promise<boolean> => {
  const result = await queryOne<{ count: string }>(
    `SELECT (
       (SELECT COUNT(*) FROM transactions WHERE debit_account_id = $1) +
       (SELECT COUNT(*) FROM transactions WHERE credit_account_id = $1)
     )::text AS count`,
    [accountId]
  );
  return result ? parseInt(result.count, 10) > 0 : false;
};

export const softDeleteAccount = async (id: number, userId: number): Promise<boolean> => {
  const count = await execute(
    'UPDATE accounts SET deleted = true WHERE id = $1 AND user_id = $2 AND deleted = false',
    [id, userId]
  );
  return count > 0;
};

export const hardDeleteAccount = async (id: number, userId: number): Promise<boolean> => {
  const count = await execute(
    'DELETE FROM accounts WHERE id = $1 AND user_id = $2 AND deleted = false',
    [id, userId]
  );
  return count > 0;
};