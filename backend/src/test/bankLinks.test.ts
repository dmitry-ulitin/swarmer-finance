import request from 'supertest';
import crypto from 'crypto';
import { createTestApp } from './testApp';
import { pool } from '../db';

const app = createTestApp();

describe('bank links on accounts', () => {
  const savedKey = process.env.BANK_CREDENTIALS_KEY;
  const originalFetch = global.fetch;
  type U = { token: string; id: number };

  beforeAll(() => {
    process.env.BANK_CREDENTIALS_KEY = crypto.randomBytes(32).toString('base64');
    // GET /api/accounts converts balances; keep it off the network.
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ date: new Date().toISOString().slice(0, 10), rates: {} }),
    }) as unknown as typeof fetch;
  });
  afterAll(() => {
    global.fetch = originalFetch;
    if (savedKey === undefined) delete process.env.BANK_CREDENTIALS_KEY;
    else process.env.BANK_CREDENTIALS_KEY = savedKey;
  });

  const register = async (prefix: string): Promise<U> => {
    const email = `${prefix}${Date.now()}${Math.random().toString(36).slice(2, 6)}@example.com`;
    const res = await request(app).post('/api/auth/register').send({ email, password: 'password123' });
    const id = (await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id;
    return { token: res.body.data.accessToken as string, id };
  };
  const auth = (u: U) => ({ Authorization: `Bearer ${u.token}` });

  const makeAccount = async (
    userId: number,
    type = 'bank',
    currency = 'USD',
    settings: object = {}
  ) =>
    (await pool.query(
      `INSERT INTO accounts (user_id, name, currency, start_balance, scale, type, settings)
       VALUES ($1, 'Acc', $2, 0, 2, $3, $4) RETURNING id`,
      [userId, currency, type, JSON.stringify(settings)]
    )).rows[0].id as number;

  const grant = (accountId: number, userId: number, level: number) =>
    pool.query('INSERT INTO account_shares (account_id, user_id, level) VALUES ($1, $2, $3)', [
      accountId, userId, level,
    ]);

  const makeConnection = async (userId: number, accountCurrency = 'USD') => {
    const id = (await pool.query(
      `INSERT INTO bank_connections (user_id, aspsp_name, aspsp_country, session_id, valid_until)
       VALUES ($1, 'LHV Pank', 'EE', 'sess', now() + interval '90 days') RETURNING id`,
      [userId]
    )).rows[0].id as number;
    await pool.query(
      `INSERT INTO bank_connection_accounts (connection_id, uid, iban, name, currency)
       VALUES ($1, 'uid-1', 'EE01', 'Main', $2)`,
      [id, accountCurrency]
    );
    return id;
  };

  /** PUT the account as it is stored, with only the bank link changed. */
  const putLink = async (u: U, accountId: number, bankLink: { connectionId: number; uid: string } | null) => {
    const { type, settings } = (await pool.query('SELECT type, settings FROM accounts WHERE id = $1', [accountId])).rows[0];
    return request(app).put(`/api/accounts/${accountId}`).set(auth(u)).send({ type, settings, bankLink });
  };
  const link = (u: U, accountId: number, connectionId: number, uid = 'uid-1') =>
    putLink(u, accountId, { connectionId, uid });
  const bankLink = async (u: U, accountId: number) => {
    const res = await request(app).get('/api/accounts').set(auth(u));
    return res.body.data.find((a: any) => a.id === accountId).bank_link;
  };

  it('links with ADMIN, refuses WRITE', async () => {
    const owner = await register('own');
    const admin = await register('adm');
    const writer = await register('wr');
    const acc = await makeAccount(owner.id);
    await grant(acc, admin.id, 3);
    await grant(acc, writer.id, 2);
    const adminConn = await makeConnection(admin.id);
    const writerConn = await makeConnection(writer.id);

    const ok = await link(admin, acc, adminConn);
    expect(ok.status).toBe(200);
    expect(ok.body.data.bank_link).toMatchObject({ connectionId: adminConn, uid: 'uid-1', accountName: 'Main', iban: 'EE01' });
    expect((await link(writer, acc, writerConn)).status).toBe(403);
    expect((await putLink(writer, acc, null)).status).toBe(403);
    const del = await putLink(admin, acc, null);
    expect(del.status).toBe(200);
    expect(del.body.data.bank_link).toBeNull();
    expect(await bankLink(owner, acc)).toBeNull();
  });

  it("refuses another user's connection", async () => {
    const a = await register('a');
    const b = await register('b');
    const acc = await makeAccount(a.id);
    const conn = await makeConnection(b.id);
    expect((await link(a, acc, conn)).status).toBe(404);
  });

  it('refuses a non-bank account and a currency mismatch', async () => {
    const u = await register('t');
    const conn = await makeConnection(u.id);
    const cash = await makeAccount(u.id, 'cash');
    const tracked = await makeAccount(u.id, 'crypto', 'BTC', { blockchain: 'bitcoin', address: 'bc1qx' });
    for (const id of [cash, tracked]) {
      const res = await link(u, id, conn);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Only a bank account can be linked to a bank');
    }
    const usd = await makeAccount(u.id, 'bank', 'USD');
    const eurConn = await makeConnection(u.id, 'EUR');
    const mismatch = await link(u, usd, eurConn);
    expect(mismatch.status).toBe(400);
    expect(mismatch.body.error).toBe('The bank account is in EUR but the account is in USD');
    const xxxConn = await makeConnection(u.id, 'XXX');
    expect((await link(u, usd, xxxConn)).status).toBe(200);
    const missing = await link(u, usd, conn, 'nope');
    expect(missing.status).toBe(400);
    expect(missing.body.error).toBe('No such bank account in this connection');
  });

  it('lists the link on the account', async () => {
    const owner = await register('own');
    const other = await register('oth');
    const acc = await makeAccount(owner.id);
    await grant(acc, other.id, 3);
    const conn = await makeConnection(owner.id);
    await link(owner, acc, conn);
    expect(await bankLink(owner, acc)).toMatchObject({
      status: 'active', loadedTo: null, ownConnection: true, aspspName: 'LHV Pank', currency: 'USD',
    });
    expect((await bankLink(other, acc)).ownConnection).toBe(false);
  });

  it('keeps loaded_to on relink of the same bank account, resets it on a change', async () => {
    const u = await register('rl');
    const acc = await makeAccount(u.id);
    const conn = await makeConnection(u.id);
    await link(u, acc, conn);
    await pool.query("UPDATE bank_account_links SET loaded_to = '2026-10-01' WHERE account_id = $1", [acc]);
    await link(u, acc, conn);
    expect((await bankLink(u, acc)).loadedTo).toBe('2026-10-01');
    await pool.query(
      `INSERT INTO bank_connection_accounts (connection_id, uid, iban, name, currency)
       VALUES ($1, 'uid-2', 'EE02', 'Second', 'USD')`, [conn]);
    await link(u, acc, conn, 'uid-2');
    expect((await bankLink(u, acc)).loadedTo).toBeNull();
  });

  it('keeps loaded_to when relinking an unmapped link within its connection', async () => {
    const u = await register('ru');
    const acc = await makeAccount(u.id);
    const conn = await makeConnection(u.id);
    await link(u, acc, conn);
    await pool.query("UPDATE bank_account_links SET loaded_to = '2026-10-01' WHERE account_id = $1", [acc]);
    await pool.query('DELETE FROM bank_connection_accounts WHERE connection_id = $1', [conn]);
    await pool.query(
      `INSERT INTO bank_connection_accounts (connection_id, uid, iban, name, currency)
       VALUES ($1, 'uid-new', 'EE01', 'Main', 'USD')`, [conn]);
    await link(u, acc, conn, 'uid-new');
    expect(await bankLink(u, acc)).toMatchObject({ status: 'active', uid: 'uid-new', loadedTo: '2026-10-01' });
    const other = await makeConnection(u.id);
    await link(u, acc, other);
    expect((await bankLink(u, acc)).loadedTo).toBeNull();
  });

  it('marks a link unmapped after a reconnect drops its uid', async () => {
    const u = await register('um');
    const acc = await makeAccount(u.id);
    const conn = await makeConnection(u.id);
    await link(u, acc, conn);
    await pool.query('DELETE FROM bank_connection_accounts WHERE connection_id = $1', [conn]);
    await pool.query(
      `INSERT INTO bank_connection_accounts (connection_id, uid, iban, name, currency)
       VALUES ($1, 'uid-new', 'EE01', 'Main', 'USD')`, [conn]);
    expect(await bankLink(u, acc)).toMatchObject({ status: 'unmapped', uid: 'uid-1', accountName: null });
  });

  it('drops the link when its owner leaves the account', async () => {
    const owner = await register('own');
    const m1 = await register('m1');
    const m2 = await register('m2');
    const acc = await makeAccount(owner.id);
    await grant(acc, m1.id, 3);
    await grant(acc, m2.id, 3);
    await link(m1, acc, await makeConnection(m1.id));
    const removed = await request(app).delete(`/api/accounts/${acc}/shares/${m1.id}`).set(auth(owner));
    expect(removed.status).toBe(200);
    expect(await bankLink(owner, acc)).toBeNull();

    await link(m2, acc, await makeConnection(m2.id));
    const left = await request(app).delete(`/api/accounts/${acc}/shares/${m2.id}`).set(auth(m2));
    expect(left.status).toBe(200);
    expect(await bankLink(owner, acc)).toBeNull();
  });

  it('drops the link when the connection owner is the removed creator', async () => {
    const owner = await register('own');
    const co = await register('co');
    const acc = await makeAccount(owner.id);
    await grant(acc, co.id, 3);
    await link(owner, acc, await makeConnection(owner.id));
    const res = await request(app).delete(`/api/accounts/${acc}/shares/${owner.id}`).set(auth(co));
    expect(res.status).toBe(200);
    expect(await bankLink(co, acc)).toBeNull();
  });

  it("keeps another member's link when someone else leaves", async () => {
    const owner = await register('own');
    const m = await register('m');
    const acc = await makeAccount(owner.id);
    await grant(acc, m.id, 3);
    await link(owner, acc, await makeConnection(owner.id));
    await request(app).delete(`/api/accounts/${acc}/shares/${m.id}`).set(auth(owner));
    expect(await bankLink(owner, acc)).not.toBeNull();
  });

  it("refuses changing a linked account's currency", async () => {
    const u = await register('cu');
    const acc = await makeAccount(u.id);
    await link(u, acc, await makeConnection(u.id));
    const res = await request(app)
      .put(`/api/accounts/${acc}`)
      .set(auth(u))
      .send({ name: 'Acc', currency: 'EUR', type: 'bank', settings: {} });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Unlink the bank first');
  });

  it('changes the currency together with a matching new link', async () => {
    const u = await register('cl');
    const acc = await makeAccount(u.id);
    await link(u, acc, await makeConnection(u.id));
    const eurConn = await makeConnection(u.id, 'EUR');
    const res = await request(app)
      .put(`/api/accounts/${acc}`)
      .set(auth(u))
      .send({ name: 'Acc', currency: 'EUR', type: 'bank', settings: {}, bankLink: { connectionId: eurConn, uid: 'uid-1' } });
    expect(res.status).toBe(200);
    expect(res.body.data.bank_link).toMatchObject({ connectionId: eurConn, currency: 'EUR' });
  });

  it("lets a co-owner edit an account linked through someone else's connection", async () => {
    const owner = await register('eo');
    const coOwner = await register('ec');
    const acc = await makeAccount(owner.id);
    await grant(acc, coOwner.id, 3);
    const conn = await makeConnection(owner.id);
    await link(owner, acc, conn);
    const res = await request(app)
      .put(`/api/accounts/${acc}`)
      .set(auth(coOwner))
      .send({ name: 'Renamed', type: 'bank', settings: {}, bankLink: { connectionId: conn, uid: 'uid-1' } });
    expect(res.status).toBe(200);
    expect(res.body.data.bank_link).toMatchObject({ connectionId: conn, ownConnection: false });
    const kept = await request(app)
      .put(`/api/accounts/${acc}`)
      .set(auth(coOwner))
      .send({ name: 'Renamed again', type: 'bank', settings: {} });
    expect(kept.status).toBe(200);
    expect(kept.body.data.bank_link).not.toBeNull();
  });

  it('links a new account on creation', async () => {
    const u = await register('nc');
    const conn = await makeConnection(u.id);
    const res = await request(app)
      .post('/api/accounts')
      .set(auth(u))
      .send({ name: 'New', currency: 'USD', type: 'bank', bankLink: { connectionId: conn, uid: 'uid-1' } });
    expect(res.status).toBe(200);
    expect(res.body.data.bank_link).toMatchObject({ connectionId: conn, uid: 'uid-1', loadedTo: null });

    const bad = await request(app)
      .post('/api/accounts')
      .set(auth(u))
      .send({ name: 'Cash', currency: 'USD', type: 'cash', bankLink: { connectionId: conn, uid: 'uid-1' } });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('Only a bank account can be linked to a bank');
    const count = await pool.query("SELECT count(*)::int AS n FROM accounts WHERE user_id = $1 AND name = 'Cash'", [u.id]);
    expect(count.rows[0].n).toBe(0);
  });

  it("refuses changing a linked account's type", async () => {
    const u = await register('ty');
    const acc = await makeAccount(u.id);
    await link(u, acc, await makeConnection(u.id));
    const res = await request(app)
      .put(`/api/accounts/${acc}`)
      .set(auth(u))
      .send({ name: 'Acc', currency: 'USD', type: 'cash', settings: {} });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Unlink the bank first');
  });
});
