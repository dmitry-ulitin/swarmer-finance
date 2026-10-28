import request from 'supertest';
import { createTestApp } from './testApp';
import { pool } from '../db';
import { resetHistoryAttempts } from '../services/currency';
import { addDays, todayUtc } from '../services/date';

const app = createTestApp();

const PAIRS = ['USD', 'XYZ'];

function routedFetch() {
  return jest.fn(async (input: unknown) => {
    const url = String(input);
    const ok = (body: unknown) => ({ ok: true, status: 200, json: async () => body });
    if (url.includes('frankfurter') && url.includes('base=USD')) {
      const range = url.match(/\/(\d{4}-\d{2}-\d{2})\.\.(\d{4}-\d{2}-\d{2})\?/);
      if (range) {
        const rates: Record<string, Record<string, number>> = {};
        for (let d = range[1]; d <= range[2]; d = addDays(d, 1)) rates[d] = { EUR: 0.5 };
        return ok({ rates });
      }
      return ok({ date: todayUtc(), rates: { EUR: 0.5 } });
    }
    if (url.includes('frankfurter')) return ok({ date: todayUtc(), rates: {} });
    return { ok: false, status: 404, json: async () => ({}) };
  });
}

describe('GET /api/net-worth', () => {
  const originalFetch = global.fetch;
  let token: string;
  let userId: number;
  const auth = () => ({ Authorization: `Bearer ${token}` });

  const makeAccount = async (name: string, currency: string, type: string, scale = 2) =>
    (await pool.query(
      `INSERT INTO accounts (user_id, name, currency, start_balance, scale, type, created_at)
       VALUES ($1, $2, $3, 0, $4, $5, '2026-01-01') RETURNING id`,
      [userId, name, currency, scale, type]
    )).rows[0].id as number;
  const income = (acc: number, amount: number, date: string) =>
    pool.query(
      `INSERT INTO transactions (user_id, credit_account_id, debit, credit, category_id, date)
       VALUES ($1, $2, $3, $3, 4, $4)`,
      [userId, acc, amount, date]
    );
  const expense = (acc: number, amount: number, date: string) =>
    pool.query(
      `INSERT INTO transactions (user_id, debit_account_id, debit, credit, category_id, date)
       VALUES ($1, $2, $3, $3, 3, $4)`,
      [userId, acc, amount, date]
    );
  const transfer = (from: number, to: number, amount: number, date: string) =>
    pool.query(
      `INSERT INTO transactions (user_id, debit_account_id, credit_account_id, debit, credit, date)
       VALUES ($1, $2, $3, $4, $4, $5)`,
      [userId, from, to, amount, date]
    );
  const get = async () => {
    const res = await request(app).get('/api/net-worth').set(auth());
    expect(res.status).toBe(200);
    return res.body.data;
  };
  const point = (data: { history: { date: string }[] }, date: string) =>
    data.history.find(p => p.date === date) as any;

  const clean = () =>
    pool.query(`DELETE FROM exchange_rates WHERE from_currency = ANY($1)`, [PAIRS]);

  beforeAll(async () => {
    const res = await request(app).post('/api/auth/register').send({ email: 'nw-api@example.com', password: 'password123' });
    token = res.body.data.accessToken;
    userId = (await pool.query('SELECT id FROM users WHERE email = $1', ['nw-api@example.com'])).rows[0].id;
  });
  beforeEach(async () => {
    resetHistoryAttempts();
    await clean();
    await pool.query('DELETE FROM account_valuations');
    await pool.query('DELETE FROM transactions');
    await pool.query('DELETE FROM accounts WHERE user_id = $1', [userId]);
    global.fetch = routedFetch() as unknown as typeof fetch;
  });
  afterEach(() => {
    global.fetch = originalFetch;
  });
  afterAll(clean);

  it('is empty for a user without accounts', async () => {
    const data = await get();
    expect(data.currency).toBe('EUR');
    expect(data.total).toBe(0);
    expect(data.approximate).toBe(false);
    expect(data.accounts).toEqual([]);
    expect(data.history.at(-1)).toMatchObject({ date: todayUtc(), total: 0 });
  });

  it('builds month-end history across currencies and ends at the account list total', async () => {
    const cash = await makeAccount('Cash', 'EUR', 'cash');
    const bank = await makeAccount('Bank', 'USD', 'bank');
    await income(cash, 10000, '2026-08-15');
    await income(bank, 20000, '2026-09-10');

    const data = await get();
    expect(point(data, '2026-08-31').total).toBe(100);
    expect(point(data, '2026-09-30').total).toBe(200);
    expect(point(data, '2026-09-30').approximate).toBe(false);
    expect(data.history[0].date).toBe('2026-08-31');

    const list = await request(app).get('/api/accounts').set(auth());
    const sum = list.body.data.reduce((s: number, a: { user_balance: number }) => s + a.user_balance, 0);
    expect(data.total).toBe(sum);
    expect(data.total).toBe(200);
    expect(data.history.at(-1)).toMatchObject({ date: todayUtc(), total: data.total });
    expect(data.byCurrency).toEqual(expect.arrayContaining([
      { currency: 'EUR', value: 100 }, { currency: 'USD', value: 100 },
    ]));
    expect(data.byType).toEqual(expect.arrayContaining([
      { type: 'cash', value: 100 }, { type: 'bank', value: 100 },
    ]));
  });

  it('values an investment account by its valuation and reports the gain', async () => {
    const bank = await makeAccount('Bank', 'EUR', 'bank');
    const inv = await makeAccount('Broker', 'EUR', 'investment');
    await income(bank, 200000, '2026-08-01');
    await transfer(bank, inv, 100000, '2026-08-20');
    await pool.query(
      `INSERT INTO account_valuations (account_id, as_of, value, user_id) VALUES ($1, '2026-09-30', 150000, $2)`,
      [inv, userId]
    );

    const data = await get();
    const typeValue = (p: any) => p.byType.investment;
    expect(typeValue(point(data, '2026-08-31'))).toBe(1000);
    expect(typeValue(point(data, '2026-09-30'))).toBe(1500);
    expect(data.byType).toContainEqual({ type: 'investment', value: 1500 });
    const row = data.accounts.find((a: { id: number }) => a.id === inv);
    expect(row).toMatchObject({
      name: 'Broker', type: 'investment', currency: 'EUR',
      value: 1500, valueUser: 1500, invested: 1000, gain: 500, gainPct: 50, inNetWorth: true,
    });
    const bankRow = data.accounts.find((a: { id: number }) => a.id === bank);
    expect(bankRow.gainPct).toBe(0);
  });

  it('gives gainPct null when nothing was invested', async () => {
    const inv = await makeAccount('Empty', 'EUR', 'investment');
    await pool.query(
      `INSERT INTO account_valuations (account_id, as_of, value, user_id) VALUES ($1, '2026-09-30', 5000, $2)`,
      [inv, userId]
    );
    const row = (await get()).accounts.find((a: { id: number }) => a.id === inv);
    expect(row).toMatchObject({ value: 50, invested: 0, gain: 50, gainPct: null });
  });

  it('leaves a deselected account out of totals but keeps it in the list', async () => {
    const a = await makeAccount('In', 'EUR', 'cash');
    const b = await makeAccount('Out', 'EUR', 'cash');
    await income(a, 10000, '2026-08-15');
    await income(b, 5000, '2026-08-15');
    await pool.query(
      'INSERT INTO account_user_settings (account_id, user_id, in_net_worth) VALUES ($1, $2, false)',
      [b, userId]
    );

    const data = await get();
    expect(data.total).toBe(100);
    expect(point(data, '2026-08-31').total).toBe(100);
    expect(data.accounts.find((x: { id: number }) => x.id === b)).toMatchObject({ inNetWorth: false, value: 50 });
    expect(data.accounts.find((x: { id: number }) => x.id === a).inNetWorth).toBe(true);
  });

  it('counts a deleted account in history only', async () => {
    const live = await makeAccount('Live', 'EUR', 'cash');
    const old = await makeAccount('Old', 'EUR', 'cash');
    await income(old, 30000, '2026-08-10');
    await transfer(old, live, 30000, '2026-09-05');
    await pool.query('UPDATE accounts SET deleted = true WHERE id = $1', [old]);

    const data = await get();
    expect(point(data, '2026-08-31').total).toBe(300);
    expect(point(data, '2026-09-30').total).toBe(300);
    expect(data.total).toBe(300);
    expect(data.accounts.map((a: { id: number }) => a.id)).toEqual([live]);
    expect(data.byType).toEqual([{ type: 'cash', value: 300 }]);
  });

  it('skips an account with no rate and marks the result approximate', async () => {
    const cash = await makeAccount('Cash', 'EUR', 'cash');
    const odd = await makeAccount('Odd', 'XYZ', 'cash');
    await income(cash, 10000, '2026-08-15');
    await income(odd, 99900, '2026-08-15');

    const data = await get();
    expect(data.approximate).toBe(true);
    expect(data.total).toBe(100);
    expect(point(data, '2026-08-31')).toMatchObject({ total: 100, approximate: true });
    expect(data.accounts.find((a: { id: number }) => a.id === odd)).toMatchObject({ value: 999, valueUser: null });
  });

  it('requires authentication', async () => {
    const res = await request(app).get('/api/net-worth');
    expect(res.status).toBe(401);
  });
});
