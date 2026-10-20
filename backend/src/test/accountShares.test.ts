import request from 'supertest';
import { createTestApp } from './testApp';
import { pool } from '../db';
import { AccessLevel } from '../services/access';

const app = createTestApp();

describe('Account share management', () => {
  let tokenA: string;
  let tokenB: string;
  let tokenC: string;
  let aId: number;
  let bId: number;
  let cId: number;
  let aEmail: string;
  let bEmail: string;
  let cEmail: string;
  let acc: number; // owned by A

  // GET /api/accounts performs currency conversion, which would otherwise
  // reach the real Frankfurter API.
  const originalFetch = global.fetch;
  beforeAll(() => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ date: new Date().toISOString().slice(0, 10), rates: {} }),
    }) as unknown as typeof fetch;
  });
  afterAll(() => {
    global.fetch = originalFetch;
  });

  const register = async (email: string) => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email, password: 'password123' });
    const user = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    return { token: res.body.data.accessToken as string, id: user.rows[0].id as number };
  };

  const makeAccount = async (userId: number, name: string) => {
    const res = await pool.query(
      `INSERT INTO accounts (user_id, name, currency, start_balance, scale)
       VALUES ($1, $2, 'USD', 0, 2) RETURNING id`,
      [userId, name]
    );
    return res.rows[0].id as number;
  };

  const grant = async (accountId: number, userId: number, level: AccessLevel) => {
    await pool.query(
      `INSERT INTO account_shares (account_id, user_id, level) VALUES ($1, $2, $3)
       ON CONFLICT (account_id, user_id) DO UPDATE SET level = EXCLUDED.level`,
      [accountId, userId, level]
    );
  };

  const list = (token: string) =>
    request(app).get(`/api/accounts/${acc}/shares`).set('Authorization', `Bearer ${token}`);
  const add = (token: string, email: string, level: unknown) =>
    request(app)
      .post(`/api/accounts/${acc}/shares`)
      .set('Authorization', `Bearer ${token}`)
      .send({ email, level });

  beforeAll(async () => {
    const stamp = Date.now();
    aEmail = `ashare-a${stamp}@example.com`;
    bEmail = `ashare-b${stamp}@example.com`;
    cEmail = `ashare-c${stamp}@example.com`;
    const a = await register(aEmail);
    const b = await register(bEmail);
    const c = await register(cEmail);
    tokenA = a.token; aId = a.id;
    tokenB = b.token; bId = b.id;
    tokenC = c.token; cId = c.id;

    await pool.query('UPDATE users SET name = $1 WHERE id = $2', ['Alice', aId]);
    await pool.query('UPDATE users SET name = $1 WHERE id = $2', ['Bob', bId]);
    await pool.query('UPDATE users SET name = $1 WHERE id = $2', ['Carol', cId]);

    acc = await makeAccount(aId, 'Shared');
  });

  afterAll(async () => {
    await pool.query('DELETE FROM account_shares WHERE account_id = $1', [acc]);
    await pool.query('DELETE FROM accounts WHERE user_id = ANY($1::int[])', [[aId, bId, cId]]);
    await pool.query('DELETE FROM categories WHERE user_id = ANY($1::int[])', [[aId, bId, cId]]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [[aId, bId, cId]]);
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM account_shares WHERE account_id = $1', [acc]);
  });

  it('lists the creator and shares for a level-1 member', async () => {
    await grant(acc, bId, 1);
    const res = await list(tokenB);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      { user_id: aId, name: 'Alice', email: aEmail, level: 4, is_creator: true },
      { user_id: bId, name: 'Bob', email: bEmail, level: 1, is_creator: false },
    ]);
  });

  it('403 listing without access', async () => {
    const res = await list(tokenC);
    expect(res.status).toBe(403);
  });

  it('adds by email, case-insensitive and trimmed', async () => {
    const res = await add(tokenA, `  ${cEmail.toUpperCase()} `, 2);
    expect(res.status).toBe(200);
    expect(res.body.data).toContainEqual(
      { user_id: cId, name: 'Carol', email: cEmail, level: 2, is_creator: false }
    );
  });

  it('404 for unknown email', async () => {
    const res = await add(tokenA, 'nobody-here@example.com', 1);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('No user with this email');
  });

  it('400 sharing with yourself', async () => {
    const res = await add(tokenA, aEmail, 1);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Cannot share an account with yourself');
  });

  it('409 for an existing member', async () => {
    await grant(acc, bId, 1);
    const res = await add(tokenA, bEmail, 2);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('This user already has access');
  });

  it('409 when the email is the creator', async () => {
    await grant(acc, bId, 3);
    const res = await add(tokenB, aEmail, 1);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('This user already has access');
  });

  it('403 adding at level 2', async () => {
    await grant(acc, bId, 2);
    const res = await add(tokenB, cEmail, 1);
    expect(res.status).toBe(403);
  });

  it('granting co-owner makes the creator level 3', async () => {
    const res = await add(tokenA, bEmail, 3);
    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({ user_id: aId, level: 3, is_creator: true });

    const accounts = await request(app).get('/api/accounts').set('Authorization', `Bearer ${tokenA}`);
    const found = accounts.body.data.find((x: { id: number }) => x.id === acc);
    expect(found.access_level).toBe(3);
  });

  it('400 for level 4 in the body', async () => {
    const res = await add(tokenA, cEmail, 4);
    expect(res.status).toBe(400);
  });
});
