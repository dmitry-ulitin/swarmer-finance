import request from 'supertest';
import { createTestApp } from './testApp';
import { pool } from '../db';
import { addDays, todayUtc } from '../services/date';

const app = createTestApp();

describe('Account valuations', () => {
  let owner: string;
  let reader: string;
  let writer: string;
  let acc: number;
  let other: number;

  const register = async (email: string) => {
    const res = await request(app).post('/api/auth/register').send({ email, password: 'password123' });
    const user = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    return { token: res.body.data.accessToken as string, id: user.rows[0].id as number };
  };
  const makeAccount = async (userId: number, name: string) => {
    const res = await pool.query(
      `INSERT INTO accounts (user_id, name, currency, start_balance, scale, type)
       VALUES ($1, $2, 'EUR', 0, 2, 'property') RETURNING id`,
      [userId, name]
    );
    return res.rows[0].id as number;
  };
  const grant = (accountId: number, userId: number, level: number) =>
    pool.query('INSERT INTO account_shares (account_id, user_id, level) VALUES ($1, $2, $3)', [
      accountId,
      userId,
      level,
    ]);
  const url = (id: number, vid?: number) =>
    `/api/accounts/${id}/valuations${vid ? `/${vid}` : ''}`;
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });

  beforeAll(async () => {
    const o = await register('val-owner@example.com');
    const r = await register('val-reader@example.com');
    const w = await register('val-writer@example.com');
    owner = o.token;
    reader = r.token;
    writer = w.token;
    acc = await makeAccount(o.id, 'House');
    other = await makeAccount(o.id, 'Flat');
    await grant(acc, r.id, 1);
    await grant(acc, w.id, 2);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM account_valuations');
  });

  it('lets READ list but not create; WRITE creates with decimal value', async () => {
    const denied = await request(app).post(url(acc)).set(auth(reader)).send({ asOf: '2026-01-01', value: 10 });
    expect(denied.status).toBe(403);

    const res = await request(app).post(url(acc)).set(auth(writer)).send({ asOf: '2026-01-01', value: 1234.56 });
    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ account_id: acc, as_of: '2026-01-01', value: 1234.56 });

    const list = await request(app).get(url(acc)).set(auth(reader));
    expect(list.status).toBe(200);
    expect(list.body.data).toHaveLength(1);
    expect(list.body.data[0].as_of).toBe('2026-01-01');
  });

  it('rejects a second valuation on the same date', async () => {
    const res = await request(app).post(url(acc)).set(auth(owner)).send({ asOf: '2026-01-01', value: 5 });
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('A valuation for this date already exists');
  });

  it('rejects future dates', async () => {
    const res = await request(app)
      .post(url(acc))
      .set(auth(owner))
      .send({ asOf: addDays(todayUtc(), 1), value: 5 });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('A valuation cannot be in the future');
  });

  it('updates and deletes; other account valuation is 404', async () => {
    const made = await request(app).post(url(other)).set(auth(owner)).send({ asOf: '2026-02-01', value: 7 });
    const vid = made.body.data.id as number;

    expect((await request(app).put(url(acc, vid)).set(auth(owner)).send({ asOf: '2026-02-01', value: 8 })).status).toBe(404);
    expect((await request(app).delete(url(acc, vid)).set(auth(owner))).status).toBe(404);

    const upd = await request(app).put(url(other, vid)).set(auth(owner)).send({ asOf: '2026-02-02', value: 8.5 });
    expect(upd.status).toBe(200);
    expect(upd.body.data).toMatchObject({ as_of: '2026-02-02', value: 8.5 });

    expect((await request(app).delete(url(other, vid)).set(auth(owner))).status).toBe(200);
    expect((await request(app).get(url(other)).set(auth(owner))).body.data).toHaveLength(0);
  });

  it('returns 404 for a deleted account', async () => {
    const gone = await makeAccount(
      (await pool.query('SELECT user_id FROM accounts WHERE id = $1', [acc])).rows[0].user_id,
      'Gone'
    );
    await pool.query('UPDATE accounts SET deleted = true WHERE id = $1', [gone]);
    const res = await request(app).post(url(gone)).set(auth(owner)).send({ asOf: '2026-01-01', value: 1 });
    expect(res.status).toBe(404);
  });
});
