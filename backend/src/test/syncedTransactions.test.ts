import request from 'supertest';
import { createTestApp } from './testApp';
import { pool } from '../db';

const app = createTestApp();

describe('Transactions on synced accounts', () => {
  let token: string;
  let userId: number;
  let walletA: number;   // tracked BTC
  let walletB: number;   // tracked BTC
  let exchange: number;  // ordinary BTC
  let euro: number;      // ordinary EUR
  let myExpenseCategory: number;
  const auth = () => ({ Authorization: `Bearer ${token}` });

  const account = async (name: string, currency: string, scale: number, type: string, settings: object) =>
    (await pool.query(
      `INSERT INTO accounts (user_id, name, currency, scale, start_balance, type, settings)
       VALUES ($1, $2, $3, $4, 0, $5, $6) RETURNING id`,
      [userId, name, currency, scale, type, JSON.stringify(settings)]
    )).rows[0].id as number;

  const row = async (fields: {
    debit?: number | null; credit?: number | null; amount: number; category?: number | null; hash?: string | null; payee?: string | null;
  }) =>
    (await pool.query(
      `INSERT INTO transactions (user_id, category_id, debit_account_id, credit_account_id, debit, credit, date, payee, import_hash)
       VALUES ($1, $2, $3, $4, $5, $5, '2026-05-29', $6, $7) RETURNING id`,
      [userId, fields.category ?? null, fields.debit ?? null, fields.credit ?? null, fields.amount, fields.payee ?? null, fields.hash ?? null]
    )).rows[0].id as number;

  beforeAll(async () => {
    const email = `synctx${Date.now()}@example.com`;
    const res = await request(app).post('/api/auth/register').send({ email, password: 'password123' });
    token = res.body.data.accessToken;
    userId = (await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id;
    walletA = await account('A', 'BTC', 8, 'crypto', { address: 'bc1qa', blockchain: 'bitcoin' });
    walletB = await account('B', 'BTC', 8, 'crypto', { address: 'bc1qb', blockchain: 'bitcoin' });
    exchange = await account('Exchange', 'BTC', 8, 'crypto', {});
    euro = await account('Euro', 'EUR', 2, 'bank', {});
    myExpenseCategory = (await pool.query(
      'SELECT id FROM categories WHERE user_id = $1 AND parent_id = 2 LIMIT 1', [userId]
    )).rows[0].id;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM transactions WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM accounts WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM categories WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM transactions WHERE user_id = $1', [userId]);
  });

  // An expense of 0.001 BTC (100000 sats) synced onto wallet A.
  const syncedExpense = () => row({ debit: walletA, amount: 100000, category: 4, hash: 'tx1', payee: 'bc1qshop' });
  // What the edit form submits for it, unchanged.
  const unchanged = {
    debitAccountId: undefined as number | undefined, creditAccountId: null as number | null,
    debit: 0.001, credit: 0.001, categoryId: 4, date: '2026-05-29', payee: 'bc1qshop', description: null,
  };
  const put = (id: number, body: object) => request(app).put(`/api/transactions/${id}`).set(auth()).send(body);

  describe('create and delete', () => {
    it('refuses creating a transaction on a synced account', async () => {
      const res = await request(app).post('/api/transactions').set(auth())
        .send({ debitAccountId: walletA, debit: 0.001, credit: 0.001, date: '2026-05-29' });
      expect(res.status).toBe(403);
      expect(res.body.error).toBe('Transactions of this account are loaded from the blockchain');
    });

    it('refuses a hand-made transfer into a synced account', async () => {
      const res = await request(app).post('/api/transactions').set(auth())
        .send({ debitAccountId: exchange, creditAccountId: walletA, debit: 0.001, credit: 0.001, date: '2026-05-29' });
      expect(res.status).toBe(403);
    });

    it('refuses deleting a synced transaction', async () => {
      const id = await syncedExpense();
      const res = await request(app).delete(`/api/transactions/${id}`).set(auth());
      expect(res.status).toBe(403);
    });

    it('still creates ordinary transactions', async () => {
      const res = await request(app).post('/api/transactions').set(auth())
        .send({ debitAccountId: exchange, debit: 0.001, credit: 0.001, date: '2026-05-29' });
      expect(res.status).toBe(200);
    });
  });

  describe('update of a one-sided synced row', () => {
    it('accepts an unchanged full payload', async () => {
      const id = await syncedExpense();
      const res = await put(id, { ...unchanged, debitAccountId: walletA });
      expect(res.status).toBe(200);
    });

    it('allows changing the category and description', async () => {
      const id = await syncedExpense();
      const res = await put(id, { ...unchanged, debitAccountId: walletA, categoryId: myExpenseCategory, description: 'coffee' });
      expect(res.status).toBe(200);
      expect(res.body.data.category.id).toBe(myExpenseCategory);
      expect(res.body.data.description).toBe('coffee');
    });

    it('allows turning it into a transfer to an ordinary account in the same currency', async () => {
      const id = await syncedExpense();
      const res = await put(id, { ...unchanged, debitAccountId: walletA, creditAccountId: exchange, categoryId: null });
      expect(res.status).toBe(200);
      expect(res.body.data.credit_account.id).toBe(exchange);
    });

    it('allows a transfer to another currency with its own amount', async () => {
      const id = await syncedExpense();
      const res = await put(id, { ...unchanged, debitAccountId: walletA, creditAccountId: euro, credit: 55.5, categoryId: null });
      expect(res.status).toBe(200);
      expect(res.body.data.credit).toBe(55.5);
    });

    it.each([
      ['date', { date: '2026-05-30' }],
      ['synced amount', { debit: 0.002, credit: 0.002 }],
      ['payee', { payee: 'someone else' }],
    ])('refuses changing the %s', async (_label, change) => {
      const id = await syncedExpense();
      const res = await put(id, { ...unchanged, debitAccountId: walletA, ...change });
      expect(res.status).toBe(400);
    });

    it('refuses moving it off the synced account', async () => {
      const id = await syncedExpense();
      const res = await put(id, { ...unchanged, debitAccountId: exchange });
      expect(res.status).toBe(400);
    });

    it('refuses pointing the other side at another synced account', async () => {
      const id = await syncedExpense();
      const res = await put(id, { ...unchanged, debitAccountId: walletA, creditAccountId: walletB, categoryId: null });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/sync only/);
    });
  });

  describe('update of a transfer between two synced wallets', () => {
    const transfer = () => row({ debit: walletA, credit: walletB, amount: 7000, hash: 'tx2', payee: 'bc1qb' });
    const same = () => ({
      debitAccountId: walletA, creditAccountId: walletB, debit: 0.00007, credit: 0.00007,
      categoryId: null, date: '2026-05-29', payee: 'bc1qb',
    });

    it('allows the description', async () => {
      const id = await transfer();
      const res = await put(id, { ...same(), description: 'to cold storage' });
      expect(res.status).toBe(200);
    });

    it('refuses replacing either wallet', async () => {
      const id = await transfer();
      const res = await put(id, { ...same(), creditAccountId: exchange });
      expect(res.status).toBe(400);
    });
  });

  it('refuses moving an ordinary transaction onto a synced account', async () => {
    const id = await row({ debit: exchange, amount: 100000, category: 4 });
    const res = await put(id, { debitAccountId: walletA });
    expect(res.status).toBe(403);
  });

  it('refuses a statement import into a synced account', async () => {
    const res = await request(app).post('/api/import/parse').set(auth())
      .send({ accountId: walletA, content: Buffer.from('x').toString('base64') });
    expect(res.status).toBe(403);
  });
});
