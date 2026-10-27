import request from 'supertest';
import crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { createTestApp } from './testApp';
import { pool } from '../db';

const app = createTestApp();
const fixture = (name: string) =>
  JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'enablebanking', name), 'utf8'));
const page1 = fixture('transactions-page1.json');
const page2 = fixture('transactions-page2.json');
const APP_ID = '3f1c6a52-6a3e-4c55-9d7c-6b1d2a9e0f11';
const PEM = crypto
  .generateKeyPairSync('rsa', { modulusLength: 2048 })
  .privateKey.export({ type: 'pkcs8', format: 'pem' })
  .toString();

const shiftDays = (date: string, days: number) => {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
};
const today = () => new Date().toISOString().slice(0, 10);

describe('POST /api/import/bank', () => {
  const savedKey = process.env.BANK_CREDENTIALS_KEY;
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;
  let txUrls: URL[];
  let txStatus: number;
  type U = { token: string; id: number };
  const users: U[] = [];

  const respond = (status: number, body: unknown) =>
    Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body } as Response);

  beforeAll(() => {
    process.env.BANK_CREDENTIALS_KEY = crypto.randomBytes(32).toString('base64');
  });

  beforeEach(() => {
    txUrls = [];
    txStatus = 200;
    fetchMock = jest.fn((url: string) => {
      const u = new URL(url);
      if (u.pathname.includes('/transactions')) {
        txUrls.push(u);
        if (txStatus !== 200) return respond(txStatus, { message: 'nope' });
        return respond(200, u.searchParams.get('continuation_key') === 'k2' ? page2 : page1);
      }
      // Exchange rates and anything else: no data.
      return respond(200, { date: today(), rates: {} });
    });
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterAll(async () => {
    global.fetch = originalFetch;
    if (savedKey === undefined) delete process.env.BANK_CREDENTIALS_KEY;
    else process.env.BANK_CREDENTIALS_KEY = savedKey;
    const ids = users.map((u) => u.id);
    await pool.query(
      `DELETE FROM transactions WHERE debit_account_id IN (SELECT id FROM accounts WHERE user_id = ANY($1))
          OR credit_account_id IN (SELECT id FROM accounts WHERE user_id = ANY($1))`,
      [ids]
    );
    await pool.query('DELETE FROM accounts WHERE user_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM bank_connections WHERE user_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM bank_credentials WHERE user_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM categories WHERE user_id = ANY($1)', [ids]);
    await pool.query('DELETE FROM users WHERE id = ANY($1)', [ids]);
  });

  const register = async (prefix: string): Promise<U> => {
    const email = `${prefix}${Date.now()}${Math.random().toString(36).slice(2, 6)}@example.com`;
    const res = await request(app).post('/api/auth/register').send({ email, password: 'password123' });
    const id = (await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id;
    const user = { token: res.body.data.accessToken as string, id: id as number };
    users.push(user);
    return user;
  };
  const auth = (u: U) => ({ Authorization: `Bearer ${u.token}` });

  const makeAccount = async (userId: number, currency = 'EUR') =>
    (await pool.query(
      `INSERT INTO accounts (user_id, name, currency, start_balance, scale, type)
       VALUES ($1, 'Bank', $2, 0, 2, 'bank') RETURNING id`,
      [userId, currency]
    )).rows[0].id as number;

  const grant = (accountId: number, userId: number, level: number) =>
    pool.query('INSERT INTO account_shares (account_id, user_id, level) VALUES ($1, $2, $3)', [
      accountId, userId, level,
    ]);

  /** Keys, an active connection with one XXX bank account, and a link to `accountId`. */
  const linkBank = async (owner: U, accountId: number, opts: { validUntil?: string; uid?: string } = {}) => {
    const keys = await request(app)
      .put('/api/bank/credentials')
      .set(auth(owner))
      .send({ applicationId: APP_ID, privateKey: PEM });
    expect(keys.status).toBe(200);
    const conn = (await pool.query(
      `INSERT INTO bank_connections (user_id, aspsp_name, aspsp_country, session_id, valid_until)
       VALUES ($1, 'LHV Pank', 'EE', 'sess', $2) RETURNING id`,
      [owner.id, opts.validUntil ?? new Date(Date.now() + 90 * 86_400_000).toISOString()]
    )).rows[0].id as number;
    await pool.query(
      `INSERT INTO bank_connection_accounts (connection_id, uid, iban, name, currency)
       VALUES ($1, 'uid-1', 'EE01', 'Main', 'XXX')`,
      [conn]
    );
    await pool.query('INSERT INTO bank_account_links (account_id, connection_id, uid) VALUES ($1, $2, $3)', [
      accountId, conn, opts.uid ?? 'uid-1',
    ]);
    return conn;
  };

  const setup = async () => {
    const u = await register('bl');
    const acc = await makeAccount(u.id);
    const conn = await linkBank(u, acc);
    return { u, acc, conn };
  };

  const load = (u: U, accountId: number, dateFrom?: string) =>
    request(app).post('/api/import/bank').set(auth(u)).send(dateFrom ? { accountId, dateFrom } : { accountId });
  const confirm = (u: U, accountId: number, rows: any[], bankLoadedTo?: string) =>
    request(app)
      .post('/api/import/reconcile')
      .set(auth(u))
      .send(bankLoadedTo ? { accountId, rows, bankLoadedTo } : { accountId, rows });
  const toReconcile = (rows: any[]) =>
    rows.map((r) => ({ date: r.date, amount: r.amount, description: r.description, payee: r.payee, hash: r.hash }));
  const loadedTo = async (accountId: number) =>
    (await pool.query(
      `SELECT to_char(loaded_to, 'YYYY-MM-DD') AS d FROM bank_account_links WHERE account_id = $1`,
      [accountId]
    )).rows[0].d as string | null;

  it('returns the review rows', async () => {
    const { u, acc } = await setup();
    const res = await load(u, acc);
    expect(res.status).toBe(200);
    const data = res.body.data;
    expect(data.format).toBe('enablebanking');
    expect(data.bank).toEqual({ dateFrom: shiftDays(today(), -90), dateTo: today() });
    expect(data.rows.map((r: any) => r.description)).toEqual([
      'CARD PURCHASE Example Shop Tallinn', 'Rent January', 'Salary', 'Service fee',
    ]);
    expect(data.rows.every((r: any) => r.status === 'new')).toBe(true);
    expect(txUrls).toHaveLength(2);
    for (const url of txUrls) {
      expect(url.pathname).toBe('/accounts/uid-1/transactions');
      expect(url.searchParams.get('date_from')).toBe(shiftDays(today(), -90));
      expect(url.searchParams.get('date_to')).toBe(today());
    }
  });

  it('refuses a load when the bank account currency differs from the account', async () => {
    const { u, acc, conn } = await setup();
    await pool.query(`UPDATE bank_connection_accounts SET currency = 'USD' WHERE connection_id = $1`, [conn]);
    const res = await load(u, acc);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('The bank account is in USD but the account is in EUR — link it again');
    expect(txUrls).toHaveLength(0);
  });

  it('loads only the account currency rows from an XXX bank account', async () => {
    const u = await register('xx');
    const acc = await makeAccount(u.id, 'USD');
    await linkBank(u, acc);
    const mk = (id: string, cur: string) => ({
      entry_reference: id, transaction_id: null, transaction_amount: { amount: '5.00', currency: cur },
      credit_debit_indicator: 'DBIT', status: 'BOOK', booking_date: '2026-10-01', value_date: null,
      remittance_information: [`row ${id}`], creditor: null, debtor: null,
    });
    const impl = fetchMock.getMockImplementation()!;
    fetchMock.mockImplementation((url: string) =>
      new URL(url).pathname.includes('/transactions')
        ? respond(200, { transactions: [mk('1', 'EUR'), mk('2', 'USD')], continuation_key: null })
        : impl(url)
    );
    const res = await load(u, acc);
    expect(res.status).toBe(200);
    expect(res.body.data.rows.map((r: any) => r.description)).toEqual(['row 2']);
  });

  it('passes the PSU headers', async () => {
    const { u, acc } = await setup();
    await load(u, acc)
      .set('X-Forwarded-For', '203.0.113.7, 10.0.0.1')
      .set('User-Agent', 'TestAgent/1.0');
    const headers = fetchMock.mock.calls.find(([url]) => String(url).includes('/transactions'))![1].headers;
    expect(headers['Psu-Ip-Address']).toBe('203.0.113.7');
    expect(headers['Psu-User-Agent']).toBe('TestAgent/1.0');
  });

  it('honours the first-load date', async () => {
    const { u, acc } = await setup();
    const res = await load(u, acc, '2026-01-15');
    expect(res.status).toBe(200);
    expect(res.body.data.bank.dateFrom).toBe('2026-01-15');
    expect(txUrls[0].searchParams.get('date_from')).toBe('2026-01-15');
  });

  it('refuses a first-load date in the future', async () => {
    const { u, acc } = await setup();
    const res = await load(u, acc, shiftDays(today(), 1));
    expect(res.status).toBe(400);
    expect(txUrls).toHaveLength(0);
  });

  it('confirm moves the marker; the next load starts two days earlier and shows duplicates', async () => {
    const { u, acc } = await setup();
    const first = (await load(u, acc)).body.data;
    const ok = await confirm(u, acc, toReconcile(first.rows), first.bank.dateTo);
    expect(ok.status).toBe(200);
    expect(ok.body.data).toEqual({ created: 4, skipped: 0 });
    expect(await loadedTo(acc)).toBe(first.bank.dateTo);

    txUrls = [];
    const second = await load(u, acc, '2026-01-15');
    expect(second.status).toBe(200);
    expect(second.body.data.bank.dateFrom).toBe(shiftDays(first.bank.dateTo, -2));
    expect(txUrls[0].searchParams.get('date_from')).toBe(shiftDays(first.bank.dateTo, -2));
    expect(second.body.data.rows.every((r: any) => r.status === 'duplicate')).toBe(true);
  });

  it('cancel does not move the marker', async () => {
    const { u, acc } = await setup();
    await load(u, acc);
    await load(u, acc);
    expect(await loadedTo(acc)).toBeNull();
    expect(txUrls.map((x) => x.searchParams.get('date_from'))).toEqual(
      Array(4).fill(shiftDays(today(), -90))
    );
  });

  it('an empty confirm moves the marker', async () => {
    const { u, acc } = await setup();
    const ok = await confirm(u, acc, [], today());
    expect(ok.status).toBe(200);
    expect(ok.body.data).toEqual({ created: 0, skipped: 0 });
    expect(await loadedTo(acc)).toBe(today());
    expect((await confirm(u, acc, [])).status).toBe(400);
  });

  it('refuses a bankLoadedTo in the future or on an unlinked account', async () => {
    const { u, acc } = await setup();
    expect((await confirm(u, acc, [], shiftDays(today(), 1))).status).toBe(400);
    expect(await loadedTo(acc)).toBeNull();
    const plain = await makeAccount(u.id);
    const res = await confirm(u, plain, [], today());
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('This account is not linked to a bank');
  });

  it('a failed confirm does not move the marker', async () => {
    const { u, acc } = await setup();
    const stranger = await register('st');
    const foreign = await makeAccount(stranger.id);
    const rows = (await load(u, acc)).body.data.rows;
    const res = await confirm(u, acc, [{ ...toReconcile(rows)[0], transferAccountId: foreign }], today());
    expect(res.status).toBe(403);
    expect(await loadedTo(acc)).toBeNull();
  });

  it('the marker never goes backwards', async () => {
    const { u, acc } = await setup();
    await confirm(u, acc, [], today());
    await confirm(u, acc, [], shiftDays(today(), -10));
    expect(await loadedTo(acc)).toBe(today());
  });

  it('possible duplicates against hand-entered rows', async () => {
    const { u, acc } = await setup();
    await pool.query(
      `INSERT INTO transactions (user_id, debit_account_id, debit, credit, category_id, date, description)
       VALUES ($1, $2, 25000, 25000, 4, '2027-01-09', 'rent by hand')`,
      [u.id, acc]
    );
    const rows = (await load(u, acc)).body.data.rows;
    const rent = rows.find((r: any) => r.description === 'Rent January');
    expect(rent.status).toBe('possible_duplicate');
    expect(rows.filter((r: any) => r.status === 'possible_duplicate')).toHaveLength(1);
  });

  it('expired consent', async () => {
    const u = await register('ex');
    const acc = await makeAccount(u.id);
    await linkBank(u, acc, { validUntil: new Date(Date.now() - 86_400_000).toISOString() });
    const res = await load(u, acc);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('Bank access expired — reconnect');
    expect(txUrls).toHaveLength(0);

    const { u: u2, acc: acc2, conn } = await setup();
    txStatus = 401;
    const revoked = await load(u2, acc2);
    expect(revoked.status).toBe(409);
    expect(revoked.body.error).toBe('Bank access expired — reconnect');
    const list = await request(app).get('/api/bank/connections').set(auth(u2));
    expect(list.body.data.find((c: any) => c.id === conn).status).toBe('expired');
  });

  it('WRITE can load, READ cannot', async () => {
    const { acc } = await setup();
    const writer = await register('wr');
    const reader = await register('rd');
    await grant(acc, writer.id, 2);
    await grant(acc, reader.id, 1);
    const ok = await load(writer, acc);
    expect(ok.status).toBe(200);
    expect(ok.body.data.rows).toHaveLength(4);
    expect((await load(reader, acc)).status).toBe(403);
  });

  it('unmapped link', async () => {
    const u = await register('um');
    const acc = await makeAccount(u.id);
    await linkBank(u, acc, { uid: 'gone' });
    const res = await load(u, acc);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('This bank account is no longer in the connection — link it again');
    expect(txUrls).toHaveLength(0);
  });

  it('refuses an unlinked account', async () => {
    const u = await register('nl');
    const acc = await makeAccount(u.id);
    const res = await load(u, acc);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('This account is not linked to a bank');
  });

  it('a window without rows in the account currency returns none', async () => {
    const u = await register('cur');
    const acc = await makeAccount(u.id, 'GBP');
    await linkBank(u, acc);
    const res = await load(u, acc);
    expect(res.status).toBe(200);
    expect(res.body.data.rows).toEqual([]);
  });

  it('503 when bank sync is not configured', async () => {
    const { u, acc } = await setup();
    const key = process.env.BANK_CREDENTIALS_KEY;
    delete process.env.BANK_CREDENTIALS_KEY;
    try {
      const res = await load(u, acc);
      expect(res.status).toBe(503);
      expect(res.body.error).toBe('Bank sync is not configured');
    } finally {
      process.env.BANK_CREDENTIALS_KEY = key;
    }
  });
});
