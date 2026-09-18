import { query } from '../index';

export interface AccessRow {
  account_id: number;
  level: number;
}

/**
 * Every account the user can reach, with the level they hold on it.
 *
 * An owned account is reported at level 4 (OWNER in services/access.ts),
 * above the three levels that account_shares can store, so all permission
 * checks reduce to `level >= required` — unless the owner has granted
 * someone else admin (level 3) on it. Such an account is co-owned rather
 * than personal, so every admin holds it at level 3 and all co-owners have
 * equal rights.
 */
export const getAccessRows = async (userId: number): Promise<AccessRow[]> => {
  return query<AccessRow>(
    `SELECT a.id AS account_id,
            CASE WHEN EXISTS (
              SELECT 1 FROM account_shares s
              WHERE s.account_id = a.id AND s.level = 3
            ) THEN 3 ELSE 4 END AS level
       FROM accounts a WHERE a.user_id = $1
     UNION ALL
     SELECT account_id, level FROM account_shares WHERE user_id = $1`,
    [userId]
  );
};
