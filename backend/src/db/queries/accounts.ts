import { query, queryOne, execute } from '../index';
import { Account } from '../../types';

export const getAccountsByUserId = async (userId: number): Promise<Account[]> => {
  return query<Account>(
    'SELECT * FROM accounts WHERE user_id = $1 ORDER BY name',
    [userId]
  );
};

export const getAccountById = async (id: number, userId: number): Promise<Account | null> => {
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
     WHERE id = $5 AND user_id = $6 RETURNING *`,
    [data.name ?? null, data.currency ?? null, data.startBalance ?? null, data.scale ?? null, id, userId]
  );
  return result[0] || null;
};

export const deleteAccount = async (id: number, userId: number): Promise<boolean> => {
  const count = await execute(
    'DELETE FROM accounts WHERE id = $1 AND user_id = $2',
    [id, userId]
  );
  return count > 0;
};
