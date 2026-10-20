import { query, execute } from '../index';
import { AccountMember } from '../../types';

export interface AccessRow {
  account_id: number;
  level: number;
}

/**
 * Everyone whose categories can show up in transactions this user can see,
 * including the user themselves.
 *
 * Both share directions matter. Owners of accounts shared *with* me author
 * transactions I can see; and someone I shared *my* account with authors
 * transactions on it with their own categories, which I can also see — so
 * neither direction alone is the full set.
 */
export const getRelatedUserIds = async (userId: number): Promise<number[]> => {
  const rows = await query<{ user_id: number }>(
    `SELECT $1::int AS user_id
     UNION
     -- owners of accounts shared with me
     SELECT a.user_id FROM accounts a
       JOIN account_shares s ON s.account_id = a.id
      WHERE s.user_id = $1
     UNION
     -- users I shared one of my accounts with
     SELECT s.user_id FROM account_shares s
       JOIN accounts a ON a.id = s.account_id
      WHERE a.user_id = $1`,
    [userId]
  );
  return rows.map(r => r.user_id);
};

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

/**
 * The creator (accounts.user_id) plus everyone in account_shares. The creator
 * resolves to 3 when someone holds 3, else 4 — the same co-owned rule as
 * getAccessRows. Creator first, then strongest level, then name.
 */
export const getAccountMembers = async (accountId: number): Promise<AccountMember[]> => {
  return query<AccountMember>(
    `SELECT user_id, name, email, level, is_creator FROM (
       SELECT u.id AS user_id, u.name, u.email,
              CASE WHEN EXISTS (
                SELECT 1 FROM account_shares s
                WHERE s.account_id = a.id AND s.level = 3
              ) THEN 3 ELSE 4 END AS level,
              true AS is_creator
         FROM accounts a JOIN users u ON u.id = a.user_id
        WHERE a.id = $1
       UNION ALL
       SELECT u.id, u.name, u.email, s.level, false
         FROM account_shares s JOIN users u ON u.id = s.user_id
        WHERE s.account_id = $1
     ) m
     ORDER BY is_creator DESC, level DESC, name`,
    [accountId]
  );
};

export const insertShare = async (
  accountId: number,
  userId: number,
  level: 1 | 2 | 3
): Promise<void> => {
  await execute(
    'INSERT INTO account_shares (account_id, user_id, level) VALUES ($1, $2, $3)',
    [accountId, userId, level]
  );
};
