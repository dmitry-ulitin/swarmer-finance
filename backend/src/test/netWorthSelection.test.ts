import request from 'supertest';
import { createTestApp } from './testApp';
import { pool } from '../db';

const app = createTestApp();

describe('Per-user net worth selection', () => {
  const originalFetch = global.fetch;
  let owner: string;
  let member: string;
  let stranger: string;
  let memberId: number;
  let acc: number;

  const register = async (email: string) => {
    const res = await request(app).post('/api/auth/register').send({ email, password: 'password123' });
    const user = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    return { token: res.body.data.accessToken as string, id: user.rows[0].id as number };
  };
  const auth = (t: string) => ({ Authorization: `Bearer ${t}` });
  const flag = async (token: string) => {
    const res = await request(app).get('/api/accounts').set(auth(token));
    return res.body.data.find((a: { id: number }) => a.id === acc).in_net_worth;
  };

  beforeAll(async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ date: new Date().toISOString().slice(0, 10), rates: {} }),
    }) as unknown as typeof fetch;
    const o = await register('nw-owner@example.com');
    const m = await register('nw-member@example.com');
    const s = await register('nw-stranger@example.com');
    owner = o.token; member = m.token; stranger = s.token; memberId = m.id;
    const res = await request(app).post('/api/accounts').set(auth(owner))
      .send({ name: 'NW', currency: 'EUR', startBalance: 0 });
    expect(res.body.data.in_net_worth).toBe(true);
    acc = res.body.data.id;
    await pool.query('INSERT INTO account_shares (account_id, user_id, level) VALUES ($1, $2, 1)', [acc, memberId]);
  });
  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('defaults: owner true, READ member false', async () => {
    expect(await flag(owner)).toBe(true);
    expect(await flag(member)).toBe(false);
  });

  it('tells each user their level and the owner', async () => {
    const row = async (token: string) => {
      const res = await request(app).get('/api/net-worth').set(auth(token));
      return res.body.data.accounts.find((a: { id: number }) => a.id === acc);
    };
    const ownerName = (await pool.query('SELECT u.name FROM accounts a JOIN users u ON u.id = a.user_id WHERE a.id = $1', [acc])).rows[0].name;
    expect(await row(owner)).toMatchObject({ accessLevel: 4, ownerName });
    expect(await row(member)).toMatchObject({ accessLevel: 1, ownerName });
  });

  it('a READ member can opt in without changing the owner flag', async () => {
    const res = await request(app).put(`/api/accounts/${acc}/net-worth`).set(auth(member)).send({ include: true });
    expect(res.status).toBe(200);
    expect(res.body.data.in_net_worth).toBe(true);
    expect(await flag(member)).toBe(true);
    expect(await flag(owner)).toBe(true);
  });

  it('the owner can opt out', async () => {
    await request(app).put(`/api/accounts/${acc}/net-worth`).set(auth(owner)).send({ include: false });
    expect(await flag(owner)).toBe(false);
    expect(await flag(member)).toBe(true);
  });

  it('rejects a bad body and a user without access', async () => {
    const bad = await request(app).put(`/api/accounts/${acc}/net-worth`).set(auth(owner)).send({ include: 'x' });
    expect(bad.status).toBe(400);
    const res = await request(app).put(`/api/accounts/${acc}/net-worth`).set(auth(stranger)).send({ include: true });
    expect([403, 404]).toContain(res.status);
  });

  it('removing a member deletes their setting', async () => {
    const before = await pool.query('SELECT 1 FROM account_user_settings WHERE account_id = $1 AND user_id = $2', [acc, memberId]);
    expect(before.rowCount).toBe(1);
    const res = await request(app).delete(`/api/accounts/${acc}/shares/${memberId}`).set(auth(owner));
    expect(res.status).toBe(200);
    const after = await pool.query('SELECT 1 FROM account_user_settings WHERE account_id = $1 AND user_id = $2', [acc, memberId]);
    expect(after.rowCount).toBe(0);
  });
});

describe('Net worth flag in the account payload', () => {
  const originalFetch = global.fetch;
  let token: string;
  let userId: number;

  const auth = () => ({ Authorization: `Bearer ${token}` });
  const rows = async (accountId: number) =>
    (await pool.query('SELECT in_net_worth FROM account_user_settings WHERE account_id = $1 AND user_id = $2', [accountId, userId])).rows;

  beforeAll(async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ date: new Date().toISOString().slice(0, 10), rates: {} }),
    }) as unknown as typeof fetch;
    const res = await request(app).post('/api/auth/register').send({ email: 'nw-payload@example.com', password: 'password123' });
    token = res.body.data.accessToken;
    userId = (await pool.query('SELECT id FROM users WHERE email = $1', ['nw-payload@example.com'])).rows[0].id;
  });
  afterAll(() => {
    global.fetch = originalFetch;
  });

  it('creates an account excluded from net worth', async () => {
    const res = await request(app).post('/api/accounts').set(auth())
      .send({ name: 'Out', currency: 'EUR', startBalance: 0, inNetWorth: false });
    expect(res.status).toBe(200);
    expect(res.body.data.in_net_worth).toBe(false);
    expect(await rows(res.body.data.id)).toEqual([{ in_net_worth: false }]);
  });

  it('stores no row when the flag matches the default', async () => {
    const res = await request(app).post('/api/accounts').set(auth())
      .send({ name: 'In', currency: 'EUR', startBalance: 0, inNetWorth: true });
    expect(res.body.data.in_net_worth).toBe(true);
    expect(await rows(res.body.data.id)).toEqual([]);
  });

  it('changes the flag on update and keeps it when omitted', async () => {
    const created = await request(app).post('/api/accounts').set(auth())
      .send({ name: 'Edit', currency: 'EUR', startBalance: 0 });
    const id = created.body.data.id;
    const off = await request(app).put(`/api/accounts/${id}`).set(auth())
      .send({ name: 'Edit', type: 'cash', settings: {}, inNetWorth: false });
    expect(off.status).toBe(200);
    expect(off.body.data.in_net_worth).toBe(false);
    const kept = await request(app).put(`/api/accounts/${id}`).set(auth())
      .send({ name: 'Edited', type: 'cash', settings: {} });
    expect(kept.body.data.in_net_worth).toBe(false);
    const on = await request(app).put(`/api/accounts/${id}`).set(auth())
      .send({ name: 'Edited', type: 'cash', settings: {}, inNetWorth: true });
    expect(on.body.data.in_net_worth).toBe(true);
  });

  it('rejects a non-boolean flag', async () => {
    const res = await request(app).post('/api/accounts').set(auth())
      .send({ name: 'Bad', currency: 'EUR', startBalance: 0, inNetWorth: 'no' });
    expect(res.status).toBe(400);
  });
});
