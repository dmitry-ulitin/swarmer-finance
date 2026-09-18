import { getAccessRows } from '../db/queries/accountShares';

/**
 * Access levels. 1-3 are stored in account_shares; OWNER is synthesised by
 * the resolver for accounts the user owns alone, so every check is a plain
 * `level >= required`. An owned account that is shared with someone at ADMIN
 * is co-owned, and the owner holds it at ADMIN too — OWNER then means
 * "personal account".
 */
export const LEVEL = { READ: 1, WRITE: 2, ADMIN: 3, OWNER: 4 } as const;
export type AccessLevel = 1 | 2 | 3 | 4;

/** accountId -> level, including owned accounts at OWNER. */
export const getAccessMap = async (userId: number): Promise<Map<number, AccessLevel>> => {
  const rows = await getAccessRows(userId);
  const map = new Map<number, AccessLevel>();
  for (const row of rows) {
    const level = row.level as AccessLevel;
    const existing = map.get(row.account_id);
    // An owner could also hold a stale share row on their own account;
    // the strongest level wins.
    if (existing === undefined || level > existing) {
      map.set(row.account_id, level);
    }
  }
  return map;
};

export const getAccessibleAccountIds = async (userId: number): Promise<number[]> => {
  return [...(await getAccessMap(userId)).keys()];
};

export const getAccountLevel = async (
  accountId: number,
  userId: number
): Promise<AccessLevel | null> => {
  const map = await getAccessMap(userId);
  return map.get(accountId) ?? null;
};

/** Throws 403 when the user's level on the account is below `min`. */
export const requireLevel = async (
  accountId: number,
  userId: number,
  min: AccessLevel
): Promise<void> => {
  const level = await getAccountLevel(accountId, userId);
  if (level === null || level < min) {
    throw { statusCode: 403, message: 'Insufficient permissions for this account' };
  }
};

/**
 * Requires `min` on every account id given, ignoring null/undefined entries.
 *
 * Used for transactions: a transfer touches two accounts, and write access to
 * one of them must not be enough to move money against the other.
 */
export const requireLevelOnAll = async (
  accountIds: (number | null | undefined)[],
  userId: number,
  min: AccessLevel
): Promise<void> => {
  const ids = [...new Set(accountIds.filter((id): id is number => id != null))];
  for (const id of ids) {
    await requireLevel(id, userId, min);
  }
};
