import { query, queryOne, execute, Tx } from '../index';
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
  level: 1 | 2 | 3,
  tx?: Tx
): Promise<void> => {
  const sql = 'INSERT INTO account_shares (account_id, user_id, level) VALUES ($1, $2, $3)';
  const params = [accountId, userId, level];
  await (tx ? tx.query(sql, params) : execute(sql, params));
};

/** The member's stored level, or null when they hold no share row. */
export const getShareLevel = async (accountId: number, userId: number): Promise<1 | 2 | 3 | null> => {
  const row = await queryOne<{ level: 1 | 2 | 3 }>(
    'SELECT level FROM account_shares WHERE account_id = $1 AND user_id = $2',
    [accountId, userId]
  );
  return row?.level ?? null;
};

export const updateShareLevel = async (
  accountId: number,
  userId: number,
  level: 1 | 2 | 3
): Promise<void> => {
  await execute(
    'UPDATE account_shares SET level = $3 WHERE account_id = $1 AND user_id = $2',
    [accountId, userId, level]
  );
};

export const deleteShare = async (tx: Tx, accountId: number, userId: number): Promise<void> => {
  await tx.query('DELETE FROM account_shares WHERE account_id = $1 AND user_id = $2', [accountId, userId]);
};

/** Distinct categories of the expense/income rows `fromUserId` entered on the account. */
export const getAuthoredCategoryIds = async (
  accountId: number,
  fromUserId: number
): Promise<{ id: number; user_id: number | null }[]> => {
  return query<{ id: number; user_id: number | null }>(
    `SELECT DISTINCT c.id, c.user_id FROM transactions t
       JOIN categories c ON c.id = t.category_id
      WHERE ((t.debit_account_id = $1 AND t.credit_account_id IS NULL)
          OR (t.credit_account_id = $1 AND t.debit_account_id IS NULL))
        AND t.user_id = $2`,
    [accountId, fromUserId]
  );
};

/**
 * Hand a departing member's expense/income rows on the account (exactly one
 * account column set) to `ownerId`, re-pointing each category through
 * `categoryMap`; ids absent from the map stay. Transfers keep their author.
 * Selecting by author here is a data move, not an access filter.
 */
export const moveHistoryToOwner = async (
  tx: Tx,
  accountId: number,
  fromUserId: number,
  ownerId: number,
  categoryMap: Map<number, number>
): Promise<void> => {
  await tx.query(
    `UPDATE transactions t
        SET user_id = $3,
            category_id = COALESCE(
              (SELECT m.to_id FROM unnest($4::int[], $5::int[]) AS m(from_id, to_id)
                WHERE m.from_id = t.category_id),
              t.category_id)
      WHERE ((t.debit_account_id = $1 AND t.credit_account_id IS NULL)
          OR (t.credit_account_id = $1 AND t.debit_account_id IS NULL))
        AND t.user_id = $2`,
    [accountId, fromUserId, ownerId, [...categoryMap.keys()], [...categoryMap.values()]]
  );
};

/** The co-owner (level 3) granted first, other than `excludeUserId`, or null. */
export const getEarliestCoOwner = async (
  accountId: number,
  excludeUserId: number
): Promise<number | null> => {
  const row = await queryOne<{ user_id: number }>(
    `SELECT user_id FROM account_shares
      WHERE account_id = $1 AND level = 3 AND user_id <> $2
      ORDER BY created_at, user_id LIMIT 1`,
    [accountId, excludeUserId]
  );
  return row?.user_id ?? null;
};

/** Make `newOwnerId` the creator; ownership is not a share, so drop theirs. */
export const transferOwnership = async (tx: Tx, accountId: number, newOwnerId: number): Promise<void> => {
  await tx.query('UPDATE accounts SET user_id = $2 WHERE id = $1', [accountId, newOwnerId]);
  await deleteShare(tx, accountId, newOwnerId);
};
