import { query, execute, Tx } from '../index';

/** Explicit net-worth flags of the user; accounts without a row are absent. */
export const getNetWorthFlags = async (userId: number, accountIds: number[]): Promise<Map<number, boolean>> => {
  if (accountIds.length === 0) return new Map();
  const rows = await query<{ account_id: number; in_net_worth: boolean }>(
    'SELECT account_id, in_net_worth FROM account_user_settings WHERE user_id = $1 AND account_id = ANY($2)',
    [userId, accountIds]
  );
  return new Map(rows.map(r => [r.account_id, r.in_net_worth]));
};

export const upsertNetWorthFlag = async (userId: number, accountId: number, include: boolean): Promise<void> => {
  await execute(
    `INSERT INTO account_user_settings (account_id, user_id, in_net_worth) VALUES ($1, $2, $3)
     ON CONFLICT (account_id, user_id) DO UPDATE SET in_net_worth = EXCLUDED.in_net_worth`,
    [accountId, userId, include]
  );
};

export const deleteUserSettings = async (tx: Tx, accountId: number, userId: number): Promise<void> => {
  await tx.query('DELETE FROM account_user_settings WHERE account_id = $1 AND user_id = $2', [accountId, userId]);
};
