import request from 'supertest';
import { createTestApp } from './testApp';
import { pool } from '../db';

const app = createTestApp();

// A currency code no other test uses, so its cached rate is ours alone.
const FX_CURRENCY = 'QQS';

async function register(prefix: string): Promise<{ token: string; userId: number }> {
  const email = `${prefix}${Date.now()}@example.com`;
  const res = await request(app).post('/api/auth/register').send({ email, password: 'password123' });
  const user = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  return { token: res.body.data.accessToken, userId: user.rows[0].id };
}

async function insertCategory(userId: number, name: string, parentId: number): Promise<number> {
  const r = await pool.query(
    `INSERT INTO categories (user_id, name, parent_id) VALUES ($1, $2, $3) RETURNING id`,
    [userId, name, parentId]
  );
  return r.rows[0].id;
}

async function insertAccount(userId: number, name: string, currency: string): Promise<number> {
  const r = await pool.query(
    `INSERT INTO accounts (user_id, name, currency, start_balance, scale) VALUES ($1, $2, $3, 0, 2) RETURNING id`,
    [userId, name, currency]
  );
  return r.rows[0].id;
}

async function insertExpense(userId: number, categoryId: number, accountId: number, amount: number, date: string) {
  await pool.query(
    `INSERT INTO transactions (user_id, category_id, debit_account_id, debit, credit, date)
     VALUES ($1, $2, $3, $4, $4, $5)`,
    [userId, categoryId, accountId, amount, date]
  );
}

async function insertIncome(userId: number, categoryId: number, accountId: number, amount: number, date: string) {
  await pool.query(
    `INSERT INTO transactions (user_id, category_id, credit_account_id, debit, credit, date)
     VALUES ($1, $2, $3, $4, $4, $5)`,
    [userId, categoryId, accountId, amount, date]
  );
}

describe('GET /api/transactions/summary', () => {
  let token: string;
  let userId: number;
  let otherUserId: number;
  let eurAccount: number;
  let fxAccount: number;
  let otherAccount: number;
  let food: number;
  let cafe: number;
  let salary: number;

  const summary = (query = '') =>
    request(app).get(`/api/transactions/summary${query}`).set({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    ({ token, userId } = await register('sum'));
    ({ userId: otherUserId } = await register('sumother'));

    food = await insertCategory(userId, 'SumFood', 2);
    cafe = await insertCategory(userId, 'SumCafe', food);
    salary = await insertCategory(userId, 'SumSalary', 1);

    eurAccount = await insertAccount(userId, 'Euro', 'EUR');
    fxAccount = await insertAccount(userId, 'Fx', FX_CURRENCY);
    otherAccount = await insertAccount(otherUserId, 'Foreign', 'EUR');

    const today = new Date().toISOString().slice(0, 10);
    await pool.query(
      `INSERT INTO exchange_rates (from_currency, to_currency, rate, as_of) VALUES ($1, 'EUR', 2, $2)
       ON CONFLICT (from_currency, to_currency, as_of) DO UPDATE SET rate = EXCLUDED.rate`,
      [FX_CURRENCY, today]
    );
  });

  afterAll(async () => {
    await pool.query('DELETE FROM transactions WHERE user_id = ANY($1::int[])', [[userId, otherUserId]]);
    await pool.query('DELETE FROM accounts WHERE user_id = ANY($1::int[])', [[userId, otherUserId]]);
    await pool.query('DELETE FROM categories WHERE user_id = ANY($1::int[])', [[userId, otherUserId]]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [[userId, otherUserId]]);
    await pool.query(`DELETE FROM exchange_rates WHERE from_currency = $1`, [FX_CURRENCY]);
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM transactions WHERE user_id = ANY($1::int[])', [[userId, otherUserId]]);
  });

  it('rolls subcategories into their top-level category and sorts by total', async () => {
    await insertExpense(userId, food, eurAccount, 1000, '2026-03-01');
    await insertExpense(userId, cafe, eurAccount, 550, '2026-03-02');
    await insertIncome(userId, salary, eurAccount, 300000, '2026-03-03');

    const res = await summary();

    expect(res.status).toBe(200);
    expect(res.body.data.currency).toBe('EUR');
    expect(res.body.data.expense).toEqual([
      expect.objectContaining({
        category_id: food,
        name: 'SumFood',
        total: 15.5,
        amounts: [{ currency: 'EUR', scale: 2, amount: 15.5 }],
      }),
    ]);
    expect(res.body.data.income).toEqual([
      expect.objectContaining({ category_id: salary, name: 'SumSalary', total: 3000 }),
    ]);
  });

  it('excludes transfers', async () => {
    await pool.query(
      `INSERT INTO transactions (user_id, debit_account_id, credit_account_id, debit, credit, date)
       VALUES ($1, $2, $3, 500, 500, '2026-03-01')`,
      [userId, eurAccount, fxAccount]
    );
    await insertExpense(userId, 4, eurAccount, 1000, '2026-03-01');

    const res = await summary();

    expect(res.body.data.income).toEqual([]);
    expect(res.body.data.expense).toEqual([
      expect.objectContaining({ category_id: 4, name: 'Uncategorized', total: 10 }),
    ]);
  });

  it('applies the account and date filters', async () => {
    await insertExpense(userId, food, eurAccount, 1000, '2026-03-01');
    await insertExpense(userId, food, eurAccount, 2000, '2026-04-01');
    await insertExpense(userId, food, fxAccount, 100, '2026-03-01');

    const res = await summary(`?accounts=${eurAccount}&from=2026-03-01&to=2026-03-31`);

    expect(res.body.data.expense).toEqual([expect.objectContaining({ total: 10 })]);
  });

  it('ignores accounts the caller cannot reach', async () => {
    await insertExpense(otherUserId, 4, otherAccount, 1000, '2026-03-01');

    const res = await summary(`?accounts=${otherAccount}`);

    expect(res.status).toBe(200);
    expect(res.body.data.expense).toEqual([]);
  });

  it('converts each currency to the user currency and keeps the raw amounts', async () => {
    await insertExpense(userId, food, eurAccount, 1000, '2026-03-01');
    await insertExpense(userId, cafe, fxAccount, 500, '2026-03-01');

    const res = await summary();

    const [item] = res.body.data.expense;
    // €10 + 5 QQS at rate 2 -> €20
    expect(item.total).toBe(20);
    expect(item.amounts).toEqual(expect.arrayContaining([
      { currency: 'EUR', scale: 2, amount: 10 },
      { currency: FX_CURRENCY, scale: 2, amount: 5 },
    ]));
  });

  describe('with a co-owner', () => {
    let sharedAccount: number;

    beforeAll(async () => {
      sharedAccount = await insertAccount(otherUserId, 'Shared', 'EUR');
      await pool.query(
        `INSERT INTO account_shares (account_id, user_id, level) VALUES ($1, $2, 1)`,
        [sharedAccount, userId]
      );
    });

    it('reports the category the tree shows: the own row over an older foreign one', async () => {
      const theirs = await insertCategory(otherUserId, 'SumShared', 2);
      const mine = await insertCategory(userId, 'SumShared', 2);
      await insertExpense(otherUserId, theirs, sharedAccount, 1000, '2026-03-01');
      await insertExpense(userId, mine, eurAccount, 500, '2026-03-01');

      const res = await summary();

      expect(res.body.data.expense).toEqual([
        expect.objectContaining({ category_id: mine, name: 'SumShared', total: 15 }),
      ]);
    });

    it('reports the foreign row when the user has none at that path', async () => {
      const theirs = await insertCategory(otherUserId, 'SumTheirs', 2);
      await insertExpense(otherUserId, theirs, sharedAccount, 1000, '2026-03-01');

      const res = await summary();

      expect(res.body.data.expense).toEqual([
        expect.objectContaining({ category_id: theirs, name: 'SumTheirs', total: 10 }),
      ]);
    });
  });

  it('returns a null total when a rate is unavailable', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('network down'));
    const noRate = await insertAccount(userId, 'NoRate', 'ZZQ');
    await insertExpense(userId, food, noRate, 1000, '2026-03-01');

    const res = await summary();

    expect(res.body.data.expense).toEqual([expect.objectContaining({ total: null })]);
  });
});
