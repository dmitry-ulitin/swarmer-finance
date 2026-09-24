import request from 'supertest';
import * as fs from 'fs';
import * as path from 'path';
import { createTestApp } from './testApp';
import { pool } from '../db';
import { getCurrencyScale } from '../services/currencyScale';

const app = createTestApp();

describe('getCurrencyScale', () => {
  it.each([
    ['EUR', 2], ['JPY', 0], ['KWD', 3],
    ['BTC', 8], ['ETH', 8], ['USDT', 6], ['USDC', 6], ['SOL', 9], ['TON', 9], ['TRX', 6],
  ])('%s has %i decimals', (currency, scale) => {
    expect(getCurrencyScale(currency as string)).toBe(scale);
  });
});

describe('Account scale follows the currency', () => {
  let token: string;
  let userId: number;
  const auth = () => ({ Authorization: `Bearer ${token}` });

  // Account DTOs convert balances through the rates API; keep it offline.
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

  beforeAll(async () => {
    const email = `scale${Date.now()}@example.com`;
    const res = await request(app).post('/api/auth/register').send({ email, password: 'password123' });
    token = res.body.data.accessToken;
    userId = (await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM transactions WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM accounts WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM categories WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  });

  const create = (currency: string, startBalance = 0) =>
    request(app).post('/api/accounts').set(auth()).send({ name: `In ${currency}`, currency, startBalance });
  const update = (id: number, currency: string, startBalance = 0) =>
    request(app).put(`/api/accounts/${id}`).set(auth())
      .send({ name: `In ${currency}`, currency, startBalance, type: 'cash', settings: {} });
  const addTransaction = (accountId: number) =>
    pool.query(
      `INSERT INTO transactions (user_id, category_id, credit_account_id, debit, credit, date)
       VALUES ($1, 3, $2, 100, 100, '2026-01-01')`,
      [userId, accountId]
    );

  it.each([['BTC', 8], ['EUR', 2], ['JPY', 0]])('creates a %s account at scale %i', async (currency, scale) => {
    const res = await create(currency as string);
    expect(res.status).toBe(200);
    expect(res.body.data.scale).toBe(scale);
  });

  it('keeps sub-cent precision of a BTC start balance', async () => {
    const res = await create('BTC', 0.00146435);
    expect(res.body.data.start_balance).toBe(0.00146435);
  });

  it('no longer accepts a client-chosen scale', async () => {
    const res = await request(app).post('/api/accounts').set(auth())
      .send({ name: 'Picky', currency: 'BTC', startBalance: 0, scale: 2 });
    expect(res.status).toBe(400);
  });

  it('rescales an empty account when its currency changes', async () => {
    const created = await create('EUR');
    const res = await update(created.body.data.id, 'BTC', 0.5);
    expect(res.status).toBe(200);
    expect(res.body.data.scale).toBe(8);
    expect(res.body.data.start_balance).toBe(0.5);
  });

  it('refuses a currency change that would rescale existing transactions', async () => {
    const created = await create('EUR');
    await addTransaction(created.body.data.id);
    const res = await update(created.body.data.id, 'BTC');
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/scale/);
  });

  it('allows a currency change between currencies of the same scale', async () => {
    const created = await create('EUR');
    await addTransaction(created.body.data.id);
    const res = await update(created.body.data.id, 'USD');
    expect(res.status).toBe(200);
  });

  it('leaves the scale of an account alone when the currency does not change', async () => {
    // An account stored at a scale its currency no longer implies (e.g. one
    // the scale migration could not fix) stays editable.
    const created = await create('JPY');
    await pool.query('UPDATE accounts SET scale = 2 WHERE id = $1', [created.body.data.id]);
    await addTransaction(created.body.data.id);
    const res = await update(created.body.data.id, 'JPY');
    expect(res.status).toBe(200);
    expect(res.body.data.scale).toBe(2);
  });

  it('migration 014 moves accounts to their currency scale without changing amounts', async () => {
    const acc = (currency: string, scale: number, start: number) =>
      pool.query(
        `INSERT INTO accounts (user_id, name, currency, scale, start_balance) VALUES ($1, $2, $2, $3, $4) RETURNING id`,
        [userId, currency, scale, start]
      ).then(r => r.rows[0].id as number);
    const btc = await acc('BTC', 2, 150);      // 1.50 BTC stored at scale 2
    const eur = await acc('EUR', 2, 1000);     // already right
    const jpy = await acc('JPY', 2, 12345);    // would need a lossy decrease: left alone
    const t = await pool.query(
      `INSERT INTO transactions (user_id, debit_account_id, credit_account_id, debit, credit, date)
       VALUES ($1, $2, $3, 25, 4000, '2026-01-01') RETURNING id`,
      [userId, btc, eur]
    );

    const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'migrations', '014_rescale_accounts_to_currency.sql'), 'utf8');
    await pool.query(sql);

    const accounts = await pool.query(
      'SELECT id, scale, start_balance::text AS start FROM accounts WHERE id = ANY($1::int[]) ORDER BY id', [[btc, eur, jpy]]
    );
    expect(accounts.rows).toEqual([
      { id: btc, scale: 8, start: '150000000' },
      { id: eur, scale: 2, start: '1000' },
      { id: jpy, scale: 2, start: '12345' },
    ]);
    const row = await pool.query('SELECT debit::text, credit::text FROM transactions WHERE id = $1', [t.rows[0].id]);
    // Only the BTC side is rescaled; the EUR side keeps its cents.
    expect(row.rows[0]).toEqual({ debit: '25000000', credit: '4000' });
  });
});
