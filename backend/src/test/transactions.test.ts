import request from 'supertest';
import { createTestApp } from './testApp';
import { pool } from '../db';

const app = createTestApp();

describe('Transactions API', () => {
  let token: string;
  let testUserId: number;
  let incomeCategoryId: number;
  let expenseCategoryId: number;
  let testAccountId: number;

  beforeAll(async () => {
    const email = `tx${Date.now()}@example.com`;
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email, password: 'password123' });
    token = res.body.data.accessToken;

    const userResult = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    testUserId = userResult.rows[0].id;

    const catResult = await pool.query(`
      SELECT c.id FROM categories c
      LEFT JOIN categories p ON c.parent_id = p.id
      WHERE c.user_id = $1 AND p.id = 1 LIMIT 1
    `, [testUserId]);
    incomeCategoryId = catResult.rows[0]?.id;

    const expCatResult = await pool.query(`
      SELECT c.id FROM categories c
      LEFT JOIN categories p ON c.parent_id = p.id
      WHERE c.user_id = $1 AND p.id = 2 LIMIT 1
    `, [testUserId]);
    expenseCategoryId = expCatResult.rows[0]?.id;

    const accountResult = await pool.query(
      `INSERT INTO accounts (user_id, name, currency, start_balance)
       VALUES ($1, 'Test Account', 'USD', 0) RETURNING id`,
      [testUserId]
    );
    testAccountId = accountResult.rows[0].id;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM transactions WHERE user_id = $1', [testUserId]);
    await pool.query('DELETE FROM accounts WHERE user_id = $1', [testUserId]);
    await pool.query('DELETE FROM categories WHERE user_id = $1', [testUserId]);
    await pool.query('DELETE FROM users WHERE id = $1', [testUserId]);
  });

  describe('GET /api/transactions', () => {
    beforeEach(async () => {
      await pool.query('DELETE FROM transactions WHERE user_id = $1', [testUserId]);

      // Income: credit_account_id filled, debit_account_id null
      await pool.query(
        `INSERT INTO transactions (user_id, category_id, credit_account_id, debit, credit, currency, date, description)
         VALUES ($1, $2, $3, 1000, 1000, 'USD', '2026-02-01', 'Test income')`,
        [testUserId, incomeCategoryId, testAccountId]
      );
      // Expense: debit_account_id filled, credit_account_id null
      await pool.query(
        `INSERT INTO transactions (user_id, category_id, debit_account_id, debit, credit, currency, date, description)
         VALUES ($1, $2, $3, 50, 50, 'USD', '2026-02-15', 'Test expense')`,
        [testUserId, expenseCategoryId, testAccountId]
      );
    });

    it('should return transactions list', async () => {
      const res = await request(app)
        .get('/api/transactions')
        .set({ Authorization: `Bearer ${token}` });

      expect(res.status).toBe(200);
      expect(res.body.data.transactions).toBeInstanceOf(Array);
      expect(res.body.data.total).toBe(2);
    });

    it('should filter transactions by date range', async () => {
      const res = await request(app)
        .get('/api/transactions?from=2026-02-01&to=2026-02-10')
        .set({ Authorization: `Bearer ${token}` });

      expect(res.status).toBe(200);
      expect(res.body.data.transactions.length).toBe(1);
    });

    it('should require authentication', async () => {
      const res = await request(app)
        .get('/api/transactions');

      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/transactions', () => {
    beforeEach(async () => {
      await pool.query('DELETE FROM transactions WHERE user_id = $1', [testUserId]);
    });

    it('should create an income transaction', async () => {
      const res = await request(app)
        .post('/api/transactions')
        .set({ Authorization: `Bearer ${token}` })
        .send({
          categoryId: incomeCategoryId,
          creditAccountId: testAccountId,
          debit: 500,
          credit: 500,
          date: '2026-02-18',
          description: 'Test income',
          currency: 'USD',
        });

      expect(res.status).toBe(200);
      expect(Number(res.body.data.debit)).toBe(500);
      expect(res.body.data.currency).toBe('USD');
    });

    it('should create a transaction with non-standard currency', async () => {
      const res = await request(app)
        .post('/api/transactions')
        .set({ Authorization: `Bearer ${token}` })
        .send({
          categoryId: incomeCategoryId,
          creditAccountId: testAccountId,
          debit: 100,
          credit: 100,
          date: '2026-02-18',
          currency: 'USDT',
        });

      expect(res.status).toBe(200);
      expect(res.body.data.currency).toBe('USDT');
    });

    it('should require currency for income', async () => {
      const res = await request(app)
        .post('/api/transactions')
        .set({ Authorization: `Bearer ${token}` })
        .send({
          categoryId: incomeCategoryId,
          creditAccountId: testAccountId,
          debit: 500,
          credit: 500,
          date: '2026-02-18',
        });

      expect(res.status).toBe(400);
    });

    it('should validate leaf category', async () => {
      const res = await request(app)
        .post('/api/transactions')
        .set({ Authorization: `Bearer ${token}` })
        .send({
          categoryId: 1,
          creditAccountId: testAccountId,
          debit: 500,
          credit: 500,
          date: '2026-02-18',
          currency: 'USD',
        });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('leaf category');
    });

    it('should create a transfer transaction', async () => {
      const secondAccountResult = await pool.query(
        `INSERT INTO accounts (user_id, name, currency, start_balance)
         VALUES ($1, 'Second Account', 'EUR', 0) RETURNING id`,
        [testUserId]
      );
      const secondAccountId = secondAccountResult.rows[0].id;

      const res = await request(app)
        .post('/api/transactions')
        .set({ Authorization: `Bearer ${token}` })
        .send({
          debitAccountId: testAccountId,
          creditAccountId: secondAccountId,
          debit: 100,
          credit: 90,
          date: '2026-02-18',
        });

      expect(res.status).toBe(200);
      expect(res.body.data.category_id).toBeNull();
      expect(res.body.data.currency).toBeNull();
    });
  });

  describe('PUT /api/transactions/:id', () => {
    let transactionId: number;

    beforeEach(async () => {
      await pool.query('DELETE FROM transactions WHERE user_id = $1', [testUserId]);

      const result = await pool.query(
        `INSERT INTO transactions (user_id, category_id, credit_account_id, debit, credit, currency, date, description)
         VALUES ($1, $2, $3, 100, 100, 'USD', '2026-02-01', 'Original')
         RETURNING id`,
        [testUserId, incomeCategoryId, testAccountId]
      );
      transactionId = result.rows[0].id;
    });

    it('should update transaction', async () => {
      const res = await request(app)
        .put(`/api/transactions/${transactionId}`)
        .set({ Authorization: `Bearer ${token}` })
        .send({
          debit: 200,
          credit: 200,
          currency: 'EUR',
        });

      expect(res.status).toBe(200);
      expect(Number(res.body.data.debit)).toBe(200);
      expect(res.body.data.currency).toBe('EUR');
    });
  });

  describe('DELETE /api/transactions/:id', () => {
    let transactionId: number;

    beforeEach(async () => {
      await pool.query('DELETE FROM transactions WHERE user_id = $1', [testUserId]);

      const result = await pool.query(
        `INSERT INTO transactions (user_id, category_id, credit_account_id, debit, credit, currency, date)
         VALUES ($1, $2, $3, 100, 100, 'USD', '2026-02-01')
         RETURNING id`,
        [testUserId, incomeCategoryId, testAccountId]
      );
      transactionId = result.rows[0].id;
    });

    it('should delete transaction', async () => {
      const res = await request(app)
        .delete(`/api/transactions/${transactionId}`)
        .set({ Authorization: `Bearer ${token}` });

      expect(res.status).toBe(200);
      expect(res.body.data.success).toBe(true);
    });
  });
});
