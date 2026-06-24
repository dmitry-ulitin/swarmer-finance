import request from 'supertest';
import { createTestApp } from './testApp';
import { pool } from '../db';

const app = createTestApp();

describe('Accounts API — balance field', () => {
  let token: string;
  let testUserId: number;
  let incomeCategoryId: number;
  let expenseCategoryId: number;

  beforeAll(async () => {
    const email = `acc${Date.now()}@example.com`;
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email, password: 'password123' });
    token = res.body.data.accessToken;

    const userResult = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    testUserId = userResult.rows[0].id;

    const incResult = await pool.query(`
      SELECT c.id FROM categories c
      JOIN categories p ON c.parent_id = p.id
      WHERE c.user_id = $1 AND p.id = 1 LIMIT 1
    `, [testUserId]);
    incomeCategoryId = incResult.rows[0].id;

    const expResult = await pool.query(`
      SELECT c.id FROM categories c
      JOIN categories p ON c.parent_id = p.id
      WHERE c.user_id = $1 AND p.id = 2 LIMIT 1
    `, [testUserId]);
    expenseCategoryId = expResult.rows[0].id;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM transactions WHERE user_id = $1', [testUserId]);
    await pool.query('DELETE FROM accounts WHERE user_id = $1', [testUserId]);
    await pool.query('DELETE FROM categories WHERE user_id = $1', [testUserId]);
    await pool.query('DELETE FROM users WHERE id = $1', [testUserId]);
  });

  describe('GET /api/accounts', () => {
    let accountId: number;

    beforeEach(async () => {
      await pool.query('DELETE FROM transactions WHERE user_id = $1', [testUserId]);
      await pool.query('DELETE FROM accounts WHERE user_id = $1', [testUserId]);

      const result = await pool.query(
        `INSERT INTO accounts (user_id, name, currency, start_balance, scale)
         VALUES ($1, 'Wallet', 'USD', 10000, 2) RETURNING id`,
        [testUserId]
      );
      accountId = result.rows[0].id;
    });

    it('returns balance equal to start_balance when no transactions exist', async () => {
      const res = await request(app)
        .get('/api/accounts')
        .set({ Authorization: `Bearer ${token}` });

      expect(res.status).toBe(200);
      const account = res.body.data[0];
      expect(account.balance).toBe(10000);
    });

    it('increases balance when account receives income', async () => {
      await pool.query(
        `INSERT INTO transactions (user_id, category_id, credit_account_id, debit, credit, currency, date)
         VALUES ($1, $2, $3, 5000, 5000, 'USD', '2026-01-10')`,
        [testUserId, incomeCategoryId, accountId]
      );

      const res = await request(app)
        .get('/api/accounts')
        .set({ Authorization: `Bearer ${token}` });

      expect(res.status).toBe(200);
      expect(res.body.data[0].balance).toBe(15000); // 10000 + 5000
    });

    it('decreases balance when account pays an expense', async () => {
      await pool.query(
        `INSERT INTO transactions (user_id, category_id, debit_account_id, debit, credit, currency, date)
         VALUES ($1, $2, $3, 3000, 3000, 'USD', '2026-01-15')`,
        [testUserId, expenseCategoryId, accountId]
      );

      const res = await request(app)
        .get('/api/accounts')
        .set({ Authorization: `Bearer ${token}` });

      expect(res.status).toBe(200);
      expect(res.body.data[0].balance).toBe(7000); // 10000 - 3000
    });

    it('updates both account balances correctly for a transfer', async () => {
      const result = await pool.query(
        `INSERT INTO accounts (user_id, name, currency, start_balance, scale)
         VALUES ($1, 'Savings', 'USD', 0, 2) RETURNING id`,
        [testUserId]
      );
      const savingsId = result.rows[0].id;

      await pool.query(
        `INSERT INTO transactions (user_id, debit_account_id, credit_account_id, debit, credit, date)
         VALUES ($1, $2, $3, 4000, 4000, '2026-01-20')`,
        [testUserId, accountId, savingsId]
      );

      const res = await request(app)
        .get('/api/accounts')
        .set({ Authorization: `Bearer ${token}` });

      expect(res.status).toBe(200);
      const accounts = res.body.data as Array<{ id: number; balance: number }>;
      const wallet = accounts.find(a => a.id === accountId)!;
      const savings = accounts.find(a => a.id === savingsId)!;
      expect(wallet.balance).toBe(6000);  // 10000 - 4000
      expect(savings.balance).toBe(4000); // 0 + 4000
    });
  });

  describe('POST /api/accounts', () => {
    afterEach(async () => {
      await pool.query('DELETE FROM transactions WHERE user_id = $1', [testUserId]);
      await pool.query('DELETE FROM accounts WHERE user_id = $1', [testUserId]);
    });

    it('returns balance equal to startBalance on creation', async () => {
      const res = await request(app)
        .post('/api/accounts')
        .set({ Authorization: `Bearer ${token}` })
        .send({ name: 'New Account', currency: 'EUR', startBalance: 2000, scale: 2 });

      expect(res.status).toBe(200);
      expect(res.body.data.balance).toBe(2000);
    });

    it('accepts 4-letter crypto-style currency codes (USDT, USDC)', async () => {
      const res = await request(app)
        .post('/api/accounts')
        .set({ Authorization: `Bearer ${token}` })
        .send({ name: 'Crypto', currency: 'USDT', startBalance: 0, scale: 2 });

      expect(res.status).toBe(200);
      expect(res.body.data.currency).toBe('USDT');
    });
  });

  describe('POST /api/accounts — currency format validation', () => {
    it('rejects lowercase currency code', async () => {
      const res = await request(app)
        .post('/api/accounts')
        .set({ Authorization: `Bearer ${token}` })
        .send({ name: 'X', currency: 'usd' });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/Currency must be/);
    });

    it('rejects 2-letter currency code', async () => {
      const res = await request(app)
        .post('/api/accounts')
        .set({ Authorization: `Bearer ${token}` })
        .send({ name: 'X', currency: 'US' });
      expect(res.status).toBe(400);
    });

    it('rejects 5-letter currency code', async () => {
      const res = await request(app)
        .post('/api/accounts')
        .set({ Authorization: `Bearer ${token}` })
        .send({ name: 'X', currency: 'USDXL' });
      expect(res.status).toBe(400);
    });

    it('rejects currency with digits', async () => {
      const res = await request(app)
        .post('/api/accounts')
        .set({ Authorization: `Bearer ${token}` })
        .send({ name: 'X', currency: 'US1' });
      expect(res.status).toBe(400);
    });

    it('rejects empty currency', async () => {
      const res = await request(app)
        .post('/api/accounts')
        .set({ Authorization: `Bearer ${token}` })
        .send({ name: 'X', currency: '' });
      expect(res.status).toBe(400);
    });
  });

  describe('PUT /api/accounts/:id', () => {
    let accountId: number;

    beforeEach(async () => {
      await pool.query('DELETE FROM transactions WHERE user_id = $1', [testUserId]);
      await pool.query('DELETE FROM accounts WHERE user_id = $1', [testUserId]);

      const result = await pool.query(
        `INSERT INTO accounts (user_id, name, currency, start_balance, scale)
         VALUES ($1, 'Editable', 'USD', 5000, 2) RETURNING id`,
        [testUserId]
      );
      accountId = result.rows[0].id;
    });

    it('reflects updated startBalance in balance when no transactions exist', async () => {
      const res = await request(app)
        .put(`/api/accounts/${accountId}`)
        .set({ Authorization: `Bearer ${token}` })
        .send({ startBalance: 8000 });

      expect(res.status).toBe(200);
      expect(res.body.data.balance).toBe(8000);
    });

    it('reflects updated startBalance combined with existing transactions', async () => {
      await pool.query(
        `INSERT INTO transactions (user_id, category_id, credit_account_id, debit, credit, currency, date)
         VALUES ($1, $2, $3, 1000, 1000, 'USD', '2026-01-10')`,
        [testUserId, incomeCategoryId, accountId]
      );

      const res = await request(app)
        .put(`/api/accounts/${accountId}`)
        .set({ Authorization: `Bearer ${token}` })
        .send({ startBalance: 3000 });

      expect(res.status).toBe(200);
      expect(res.body.data.balance).toBe(4000); // 3000 + 1000
    });
  });
});
