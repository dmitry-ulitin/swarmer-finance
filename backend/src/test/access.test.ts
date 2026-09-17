import { pool } from '../db';
import { LEVEL, getAccessMap, getAccessibleAccountIds, getAccountLevel, requireLevel } from '../services/access';

describe('access resolver', () => {
  let ownerId: number;
  let granteeId: number;
  let strangerId: number;
  let ownedAccountId: number;
  let otherAccountId: number;

  beforeAll(async () => {
    const mk = async (email: string) => {
      const r = await pool.query(
        `INSERT INTO users (email, password_hash) VALUES ($1, 'x') RETURNING id`,
        [email]
      );
      return r.rows[0].id as number;
    };
    const stamp = Date.now();
    ownerId = await mk(`owner${stamp}@example.com`);
    granteeId = await mk(`grantee${stamp}@example.com`);
    strangerId = await mk(`stranger${stamp}@example.com`);

    const acc = await pool.query(
      `INSERT INTO accounts (user_id, name, currency, start_balance, scale)
       VALUES ($1, 'Owned', 'USD', 0, 2) RETURNING id`,
      [ownerId]
    );
    ownedAccountId = acc.rows[0].id;

    const other = await pool.query(
      `INSERT INTO accounts (user_id, name, currency, start_balance, scale)
       VALUES ($1, 'Other', 'USD', 0, 2) RETURNING id`,
      [ownerId]
    );
    otherAccountId = other.rows[0].id;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM account_shares WHERE account_id = ANY($1::int[])', [[ownedAccountId, otherAccountId]]);
    await pool.query('DELETE FROM accounts WHERE user_id = $1', [ownerId]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [[ownerId, granteeId, strangerId]]);
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM account_shares WHERE account_id = ANY($1::int[])', [[ownedAccountId, otherAccountId]]);
  });

  it('resolves the owner to OWNER on their own accounts', async () => {
    const map = await getAccessMap(ownerId);
    expect(map.get(ownedAccountId)).toBe(LEVEL.OWNER);
    expect(map.get(otherAccountId)).toBe(LEVEL.OWNER);
  });

  it('resolves a grant to its stored level', async () => {
    await pool.query(
      'INSERT INTO account_shares (account_id, user_id, level) VALUES ($1, $2, $3)',
      [ownedAccountId, granteeId, LEVEL.WRITE]
    );
    const map = await getAccessMap(granteeId);
    expect(map.get(ownedAccountId)).toBe(LEVEL.WRITE);
  });

  it('gives no access without a grant', async () => {
    const map = await getAccessMap(strangerId);
    expect(map.size).toBe(0);
    expect(await getAccountLevel(ownedAccountId, strangerId)).toBeNull();
  });

  it('does not leak accounts that were not granted', async () => {
    await pool.query(
      'INSERT INTO account_shares (account_id, user_id, level) VALUES ($1, $2, $3)',
      [ownedAccountId, granteeId, LEVEL.READ]
    );
    const ids = await getAccessibleAccountIds(granteeId);
    expect(ids).toContain(ownedAccountId);
    expect(ids).not.toContain(otherAccountId);
  });

  it('drops access immediately when the grant row is deleted', async () => {
    await pool.query(
      'INSERT INTO account_shares (account_id, user_id, level) VALUES ($1, $2, $3)',
      [ownedAccountId, granteeId, LEVEL.ADMIN]
    );
    expect(await getAccountLevel(ownedAccountId, granteeId)).toBe(LEVEL.ADMIN);

    await pool.query('DELETE FROM account_shares WHERE account_id = $1 AND user_id = $2', [ownedAccountId, granteeId]);
    expect(await getAccountLevel(ownedAccountId, granteeId)).toBeNull();
  });

  it('requireLevel passes at or above the minimum and throws 403 below it', async () => {
    await pool.query(
      'INSERT INTO account_shares (account_id, user_id, level) VALUES ($1, $2, $3)',
      [ownedAccountId, granteeId, LEVEL.WRITE]
    );

    await expect(requireLevel(ownedAccountId, granteeId, LEVEL.READ)).resolves.toBeUndefined();
    await expect(requireLevel(ownedAccountId, granteeId, LEVEL.WRITE)).resolves.toBeUndefined();
    await expect(requireLevel(ownedAccountId, granteeId, LEVEL.ADMIN)).rejects.toMatchObject({ statusCode: 403 });
    await expect(requireLevel(ownedAccountId, ownerId, LEVEL.OWNER)).resolves.toBeUndefined();
  });
});
