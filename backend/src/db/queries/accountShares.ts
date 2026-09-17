import { query } from '../index';

export interface AccessRow {
  account_id: number;
  level: number;
}

/**
 * Every account the user can reach, with the level they hold on it.
 *
 * Owned accounts are reported at level 4 (OWNER in services/access.ts),
 * above the three levels that account_shares can store, so all permission
 * checks reduce to `level >= required`.
 */
export const getAccessRows = async (userId: number): Promise<AccessRow[]> => {
  return query<AccessRow>(
    `SELECT id AS account_id, 4 AS level FROM accounts WHERE user_id = $1
     UNION ALL
     SELECT account_id, level FROM account_shares WHERE user_id = $1`,
    [userId]
  );
};
