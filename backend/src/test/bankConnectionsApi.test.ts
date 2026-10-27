import request from 'supertest';
import crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { createTestApp } from './testApp';
import { pool } from '../db';

const app = createTestApp();
const fixture = (name: string) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'enablebanking', name), 'utf8'));
const aspsps = fixture('aspsps-ee.json');
const APP_ID = '3f1c6a52-6a3e-4c55-9d7c-6b1d2a9e0f11';
const REDIRECT = 'https://finance.example.com/bank-callback';
const DAY = 86_400_000;

const PEM = crypto
  .generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();

describe('/api/bank keys and connections', () => {
  const savedKey = process.env.BANK_CREDENTIALS_KEY;
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;
  let authBodies: any[];
  let deleted: string[];
  let session: any;
  const users: { token: string; id: number }[] = [];

  const respond = (status: number, body: unknown) =>
    Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body } as Response);

  const register = async (prefix: string) => {
    const email = `${prefix}${Date.now()}${Math.random().toString(36).slice(2, 6)}@example.com`;
    const res = await request(app).post('/api/auth/register').send({ email, password: 'password123' });
    const id = (await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id;
    const user = { token: res.body.data.accessToken as string, id: id as number };
    users.push(user);
    return user;
  };

  const auth = (token: string) => ({ Authorization: `Bearer ${token}` });
  const enable = () => {
    process.env.BANK_CREDENTIALS_KEY = crypto.randomBytes(32).toString('base64');
  };
  const putKeys = (token: string) =>
    request(app).put('/api/bank/credentials').set(auth(token)).send({ applicationId: APP_ID, privateKey: PEM });
  const start = (token: string) =>
    request(app)
      .post('/api/bank/connections')
      .set(auth(token))
      .send({ aspspName: 'LHV Pank', country: 'EE', redirectUrl: REDIRECT });
  const complete = (token: string, state: string) =>
    request(app).post('/api/bank/connections/complete').set(auth(token)).send({ state, code: 'code-1' });

  beforeAll(() => {
    enable();
  });

  beforeEach(() => {
    authBodies = [];
    deleted = [];
    session = {
      ...fixture('session.json'),
      access: { valid_until: new Date(Date.now() + 180 * DAY).toISOString() },
    };
    fetchMock = jest.fn((url: string, init?: RequestInit) => {
      const method = init?.method ?? 'GET';
      if (method === 'GET' && url.includes('/aspsps')) return respond(200, aspsps);
      if (method === 'POST' && url.endsWith('/auth')) {
        authBodies.push(JSON.parse(String(init!.body)));
        return respond(200, { url: 'https://bank.example/consent?x=1' });
      }
      if (method === 'POST' && url.endsWith('/sessions')) return respond(200, session);
      if (method === 'DELETE' && url.includes('/sessions/')) {
        deleted.push(url.split('/sessions/')[1]);
        return respond(204, null);
      }
      return respond(404, { message: 'not mocked' });
    });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterAll(async () => {
    global.fetch = originalFetch;
    if (savedKey === undefined) delete process.env.BANK_CREDENTIALS_KEY;
    else process.env.BANK_CREDENTIALS_KEY = savedKey;
    const ids = users.map((u) => u.id);
    await pool.query('DELETE FROM accounts WHERE user_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM bank_connections WHERE user_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM bank_credentials WHERE user_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM categories WHERE user_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [ids]);
  });

  const storedState = async (userId: number) =>
    (await pool.query('SELECT auth_state FROM bank_connections WHERE user_id = $1 ORDER BY id DESC LIMIT 1', [userId]))
      .rows[0]?.auth_state as string | undefined;

  /** Keys saved and one completed connection; returns its id. */
  const connected = async (user: { token: string; id: number }) => {
    await putKeys(user.token);
    await start(user.token);
    const res = await complete(user.token, (await storedState(user.id))!);
    expect(res.status).toBe(200);
    return res.body.data.id as number;
  };

  it('requires authentication', async () => {
    const res = await request(app).get('/api/bank/credentials');
    expect(res.status).toBe(401);
  });

  it('reports disabled without BANK_CREDENTIALS_KEY', async () => {
    const user = await register('bankoff');
    delete process.env.BANK_CREDENTIALS_KEY;
    try {
      const get = await request(app).get('/api/bank/credentials').set(auth(user.token));
      expect(get.status).toBe(200);
      expect(get.body.data).toEqual({ enabled: false, applicationId: null, hasKey: false });

      const put = await putKeys(user.token);
      expect(put.status).toBe(503);
      expect(put.body.error).toBe('Bank sync is not configured');

      const list = await request(app).get('/api/bank/connections').set(auth(user.token));
      expect(list.status).toBe(503);
    } finally {
      enable();
    }
  });

  it('stores keys without ever returning them', async () => {
    const user = await register('bankkeys');
    const put = await putKeys(user.token);
    expect(put.status).toBe(200);
    expect(put.body.data).toEqual({ enabled: true, applicationId: APP_ID, hasKey: true });

    const get = await request(app).get('/api/bank/credentials').set(auth(user.token));
    expect(get.body.data).toEqual({ enabled: true, applicationId: APP_ID, hasKey: true });

    const slice = PEM.split('\n')[3];
    expect(slice.length).toBeGreaterThanOrEqual(40);
    for (const text of [put.text, get.text]) {
      expect(text).not.toContain('BEGIN');
      expect(text).not.toContain(slice.slice(0, 40));
    }
    const row = (await pool.query('SELECT private_key_enc FROM bank_credentials WHERE user_id = $1', [user.id])).rows[0];
    expect(row.private_key_enc.startsWith('v1.')).toBe(true);
    expect(row.private_key_enc).not.toContain('BEGIN');

    const del = await request(app).delete('/api/bank/credentials').set(auth(user.token));
    expect(del.body.data).toEqual({ success: true });
    const after = await request(app).get('/api/bank/credentials').set(auth(user.token));
    expect(after.body.data).toEqual({ enabled: true, applicationId: null, hasKey: false });
  });

  it('rejects a malformed PEM without echoing it', async () => {
    const user = await register('bankbadpem');
    const res = await request(app)
      .put('/api/bank/credentials')
      .set(auth(user.token))
      .send({ applicationId: APP_ID, privateKey: 'not a key SECRET123' });
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Private key is not a valid PEM');
    expect(res.text).not.toContain('SECRET123');
  });

  it('needs keys before talking to the bank', async () => {
    const user = await register('banknokeys');
    const res = await request(app).get('/api/bank/aspsps?country=EE').set(auth(user.token));
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Add your Enable Banking keys first');
  });

  it('lists banks with their consent length', async () => {
    const user = await register('bankaspsps');
    await putKeys(user.token);
    const res = await request(app).get('/api/bank/aspsps?country=EE').set(auth(user.token));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      { name: 'LHV Pank', country: 'EE', beta: true, maxConsentDays: 180 },
      { name: 'Test Bank', country: 'EE', beta: false, maxConsentDays: 90 },
    ]);
    const header = fetchMock.mock.calls[0][1].headers.Authorization as string;
    expect(res.text).not.toContain(header.slice(7, 47));
  });

  it('rejects a redirect URL that is not https /bank-callback', async () => {
    const user = await register('bankredirect');
    await putKeys(user.token);
    for (const redirectUrl of ['http://finance.example.com/bank-callback', 'https://finance.example.com/other']) {
      const res = await request(app)
        .post('/api/bank/connections')
        .set(auth(user.token))
        .send({ aspspName: 'LHV Pank', country: 'EE', redirectUrl });
      expect(res.status).toBe(400);
    }
    expect(authBodies).toHaveLength(0);
  });

  it('starts a connection', async () => {
    const user = await register('bankstart');
    await putKeys(user.token);
    const res = await start(user.token);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ url: 'https://bank.example/consent?x=1' });

    expect(authBodies).toHaveLength(1);
    const body = authBodies[0];
    expect(body.state).toBe(await storedState(user.id));
    expect(body.state).toMatch(/^[0-9a-f]{48}$/);
    expect(body.redirect_url).toBe(REDIRECT);
    expect(body.aspsp).toEqual({ name: 'LHV Pank', country: 'EE' });
    const ahead = new Date(body.access.valid_until).getTime() - Date.now();
    expect(Math.abs(ahead - 180 * DAY)).toBeLessThan(60_000);

    const list = await request(app).get('/api/bank/connections').set(auth(user.token));
    expect(list.body.data).toEqual([
      { id: expect.any(Number), aspspName: 'LHV Pank', country: 'EE', status: 'pending', validUntil: null, accounts: [] },
    ]);
  });

  it('completes a connection once', async () => {
    const user = await register('bankcomplete');
    await putKeys(user.token);
    await start(user.token);
    const state = (await storedState(user.id))!;

    const res = await complete(user.token, state);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      id: expect.any(Number),
      aspspName: 'LHV Pank',
      country: 'EE',
      status: 'active',
      validUntil: session.access.valid_until,
      accounts: [
        { uid: '11111111-1111-4111-8111-111111111111', iban: 'EE000000000000000001', name: 'Jane Doe', currency: 'XXX' },
        { uid: '22222222-2222-4222-8222-222222222222', iban: 'EE000000000000000002', name: 'Jane Doe', currency: 'EUR' },
      ],
    });
    expect(await storedState(user.id)).toBeNull();

    const again = await complete(user.token, state);
    expect(again.status).toBe(400);
    expect(again.body.error).toBe('Unknown or expired connection request');
  });

  it('refuses an expired state', async () => {
    const user = await register('bankstale');
    await putKeys(user.token);
    await start(user.token);
    const state = (await storedState(user.id))!;
    await pool.query(
      `UPDATE bank_connections SET auth_started_at = now() - interval '31 minutes' WHERE auth_state = $1`,
      [state]
    );
    const res = await complete(user.token, state);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Unknown or expired connection request');
  });

  it("refuses another user's state", async () => {
    const owner = await register('bankowner');
    const other = await register('bankother');
    await putKeys(owner.token);
    await putKeys(other.token);
    await start(owner.token);
    const state = (await storedState(owner.id))!;

    const res = await complete(other.token, state);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Unknown or expired connection request');
    const row = (await pool.query(
      'SELECT session_id, auth_state, (SELECT count(*)::int FROM bank_connection_accounts WHERE connection_id = c.id) AS n FROM bank_connections c WHERE user_id = $1',
      [owner.id]
    )).rows[0];
    expect(row).toEqual({ session_id: null, auth_state: state, n: 0 });
    expect(fetchMock.mock.calls.some(([url]) => String(url).endsWith('/sessions'))).toBe(false);
  });

  it("hides another user's connection", async () => {
    const owner = await register('bankhide');
    const other = await register('bankhider');
    const id = await connected(owner);
    await putKeys(other.token);
    const del = await request(app).delete(`/api/bank/connections/${id}`).set(auth(other.token));
    expect(del.status).toBe(404);
    expect(del.body.error).toBe('Bank connection not found');
    const re = await request(app)
      .post(`/api/bank/connections/${id}/reconnect`)
      .set(auth(other.token))
      .send({ redirectUrl: REDIRECT });
    expect(re.status).toBe(404);
  });

  it('reconnect keeps links', async () => {
    const user = await register('bankreconnect');
    const id = await connected(user);
    const oldSession = session.session_id;
    const account = (await pool.query(
      `INSERT INTO accounts (user_id, name, currency, scale, start_balance, type, settings)
       VALUES ($1, 'LHV', 'EUR', 2, 0, 'bank', '{}') RETURNING id`,
      [user.id]
    )).rows[0].id;
    await pool.query(
      `INSERT INTO bank_account_links (account_id, connection_id, uid) VALUES ($1, $2, '22222222-2222-4222-8222-222222222222')`,
      [account, id]
    );

    const re = await request(app)
      .post(`/api/bank/connections/${id}/reconnect`)
      .set(auth(user.token))
      .send({ redirectUrl: REDIRECT });
    expect(re.status).toBe(200);
    expect(re.body.data.url).toBe('https://bank.example/consent?x=1');
    const state = (await storedState(user.id))!;
    expect(authBodies[authBodies.length - 1].state).toBe(state);

    session = { ...session, session_id: '00000000-0000-4000-8000-000000000002' };
    const res = await complete(user.token, state);
    expect(res.status).toBe(200);
    expect(res.body.data.id).toBe(id);
    expect(res.body.data.status).toBe('active');
    expect(deleted).toEqual([oldSession]);

    const links = await pool.query('SELECT connection_id, uid FROM bank_account_links WHERE account_id = $1', [account]);
    expect(links.rows).toEqual([{ connection_id: id, uid: '22222222-2222-4222-8222-222222222222' }]);
    const stored = await pool.query('SELECT session_id FROM bank_connections WHERE id = $1', [id]);
    expect(stored.rows[0].session_id).toBe('00000000-0000-4000-8000-000000000002');
  });

  it('delete removes the connection and its links', async () => {
    const user = await register('bankdelete');
    const id = await connected(user);
    const account = (await pool.query(
      `INSERT INTO accounts (user_id, name, currency, scale, start_balance, type, settings)
       VALUES ($1, 'LHV', 'EUR', 2, 0, 'bank', '{}') RETURNING id`,
      [user.id]
    )).rows[0].id;
    await pool.query(
      `INSERT INTO bank_account_links (account_id, connection_id, uid) VALUES ($1, $2, '22222222-2222-4222-8222-222222222222')`,
      [account, id]
    );

    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') {
        deleted.push(url.split('/sessions/')[1]);
        return Promise.reject(new Error('ECONNREFUSED'));
      }
      return respond(404, null);
    });
    const res = await request(app).delete(`/api/bank/connections/${id}`).set(auth(user.token));
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ success: true });
    expect(deleted).toEqual([session.session_id]);
    expect((await pool.query('SELECT 1 FROM bank_connections WHERE id = $1', [id])).rowCount).toBe(0);
    expect((await pool.query('SELECT 1 FROM bank_account_links WHERE account_id = $1', [account])).rowCount).toBe(0);
    expect((await pool.query('SELECT 1 FROM accounts WHERE id = $1', [account])).rowCount).toBe(1);
  });

  it('reports expiring and expired connections', async () => {
    const user = await register('bankstatus');
    const id = await connected(user);
    const status = async () =>
      (await request(app).get('/api/bank/connections').set(auth(user.token))).body.data[0].status;

    await pool.query(`UPDATE bank_connections SET valid_until = now() + interval '3 days' WHERE id = $1`, [id]);
    expect(await status()).toBe('expiring');
    await pool.query(`UPDATE bank_connections SET valid_until = now() - interval '1 minute' WHERE id = $1`, [id]);
    expect(await status()).toBe('expired');
    await pool.query(`UPDATE bank_connections SET valid_until = now() + interval '90 days', expired = true WHERE id = $1`, [id]);
    expect(await status()).toBe('expired');
  });
});
