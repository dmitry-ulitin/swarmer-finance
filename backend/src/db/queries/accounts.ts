import { query, queryOne, execute, Tx } from '../index';
import { Account, AccountType } from '../../types';

export const getAccountsByIds = async (accountIds: number[]): Promise<Account[]> => {
  if (accountIds.length === 0) return [];
  return query<Account>(
    `SELECT a.*, u.name AS owner_name
     FROM accounts a
     JOIN users u ON u.id = a.user_id
     WHERE a.id = ANY($1::int[])
     ORDER BY a.name`,
    [accountIds]
  );
};

// Access is checked by the service layer, so this looks up by id alone.
// That also lets the service tell "no such account" (404) apart from
// "no access" (403).
export const getAccountById = async (id: number): Promise<Account | null> => {
  return queryOne<Account>(
    `SELECT a.*, u.name AS owner_name
     FROM accounts a
     JOIN users u ON u.id = a.user_id
     WHERE a.id = $1`,
    [id]
  );
};

export const createAccount = async (
  userId: number,
  name: string,
  currency: string,
  startBalance: number,
  scale: number,
  type: AccountType,
  settings: Record<string, unknown>
): Promise<Account> => {
  const result = await query<Account>(
    `INSERT INTO accounts (user_id, name, currency, start_balance, scale, type, settings)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [userId, name, currency, startBalance, scale, type, JSON.stringify(settings)]
  );
  return result[0];
};

export const updateAccount = async (
  id: number,
  data: {
    name?: string;
    currency?: string;
    startBalance?: number;
    scale?: number;
    type: AccountType;
    settings: Record<string, unknown>;
  },
  db: Pick<Tx, 'query'> = { query }
): Promise<Account | null> => {
  // `type` and `settings` are written unconditionally, not COALESCEd:
  // changing an account's type must drop the previous type's fields.
  //
  // No user_id predicate: permission is checked in services/accounts.ts.
  // Keeping one here would be worse than redundant — for an admin who is
  // not the owner it is false, and the update would silently affect no rows.
  const result = await db.query<Account>(
    `UPDATE accounts
     SET name = COALESCE($1, name),
         currency = COALESCE($2, currency),
         start_balance = COALESCE($3, start_balance),
         scale = COALESCE($4, scale),
         type = $5,
         settings = $6
     WHERE id = $7 AND deleted = false RETURNING *`,
    [
      data.name ?? null,
      data.currency ?? null,
      data.startBalance ?? null,
      data.scale ?? null,
      data.type,
      JSON.stringify(data.settings),
      id,
    ]
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

export const softDeleteAccount = async (id: number): Promise<boolean> => {
  const count = await execute(
    'UPDATE accounts SET deleted = true WHERE id = $1 AND deleted = false',
    [id]
  );
  return count > 0;
};

export const hardDeleteAccount = async (id: number): Promise<boolean> => {
  const count = await execute(
    'DELETE FROM accounts WHERE id = $1 AND deleted = false',
    [id]
  );
  return count > 0;
};
/** Removes the account inside a purge; its shares and seen txids cascade. */
export const deleteAccountRow = async (db: Tx, id: number): Promise<void> => {
  await db.query('DELETE FROM accounts WHERE id = $1', [id]);
};
