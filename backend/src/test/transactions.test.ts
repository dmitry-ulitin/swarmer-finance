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
  let secondAccountId: number;

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

    const secondAccountResult = await pool.query(
      `INSERT INTO accounts (user_id, name, currency, start_balance)
       VALUES ($1, 'Second Account', 'EUR', 0) RETURNING id`,
      [testUserId]
    );
    secondAccountId = secondAccountResult.rows[0].id;
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

      // Income on testAccount: credit_account_id filled, debit_account_id null
      await pool.query(
        `INSERT INTO transactions (user_id, category_id, credit_account_id, debit, credit, currency, date, description)
         VALUES ($1, $2, $3, 1000, 1000, 'USD', '2026-02-01', 'Test income')`,
        [testUserId, incomeCategoryId, testAccountId]
      );
      // Expense on secondAccount: debit_account_id filled, credit_account_id null
      await pool.query(
        `INSERT INTO transactions (user_id, category_id, debit_account_id, debit, credit, currency, date, description, payee)
         VALUES ($1, $2, $3, 50, 50, 'USD', '2026-02-15', 'Groceries run', 'Supermarket')`,
        [testUserId, expenseCategoryId, secondAccountId]
      );
    });

    it('should return transactions list', async () => {
      const res = await request(app)
        .get('/api/transactions')
        .set({ Authorization: `Bearer ${token}` });

      expect(res.status).toBe(200);
      expect(res.body.data).toBeInstanceOf(Array);
      expect(res.body.data.length).toBe(2);
    });

    it('should filter transactions by date range', async () => {
      const res = await request(app)
        .get('/api/transactions?from=2026-02-01&to=2026-02-10')
        .set({ Authorization: `Bearer ${token}` });

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(1);
    });

    it('should filter by single account', async () => {
      const res = await request(app)
        .get(`/api/transactions?account=${testAccountId}`)
        .set({ Authorization: `Bearer ${token}` });

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(1);
      expect(res.body.data[0].credit_account.id).toBe(testAccountId);
    });

    it('should filter by multiple accounts (OR logic)', async () => {
      const res = await request(app)
        .get(`/api/transactions?account=${testAccountId}&account=${secondAccountId}`)
        .set({ Authorization: `Bearer ${token}` });

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(2);
    });

    it('should filter by multiple categories (OR logic)', async () => {
      const res = await request(app)
        .get(`/api/transactions?category=${incomeCategoryId}&category=${expenseCategoryId}`)
        .set({ Authorization: `Bearer ${token}` });

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(2);
    });

    it('should filter by single category', async () => {
      const res = await request(app)
        .get(`/api/transactions?category=${expenseCategoryId}`)
        .set({ Authorization: `Bearer ${token}` });

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(1);
    });

    it('should filter by details matching description', async () => {
      const res = await request(app)
        .get('/api/transactions?details=Groceries')
        .set({ Authorization: `Bearer ${token}` });

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(1);
      expect(res.body.data[0].description).toBe('Groceries run');
    });

    it('should filter by details matching payee', async () => {
      const res = await request(app)
        .get('/api/transactions?details=supermarket')
        .set({ Authorization: `Bearer ${token}` });

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(1);
    });

    it('should support offset-based pagination', async () => {
      const res = await request(app)
        .get('/api/transactions?offset=1&limit=1')
        .set({ Authorization: `Bearer ${token}` });

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(1);
    });

    it('should reject invalid offset', async () => {
      const res = await request(app)
        .get('/api/transactions?offset=-1')
        .set({ Authorization: `Bearer ${token}` });

      expect(res.status).toBe(400);
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
          scale: 2,
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
          scale: 2,
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
      expect(res.body.data.category).toBeNull();
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

  describe('GET /api/transactions — running balances', () => {
    beforeEach(async () => {
      await pool.query('DELETE FROM transactions WHERE user_id = $1', [testUserId]);
    });

    it('attaches balance to account when no sequential-breaking filters are active', async () => {
      await pool.query(
        `INSERT INTO transactions (user_id, category_id, credit_account_id, debit, credit, currency, date)
         VALUES ($1, $2, $3, 5000, 5000, 'USD', '2026-03-01')`,
        [testUserId, incomeCategoryId, testAccountId]
      );

      const res = await request(app)
        .get('/api/transactions')
        .set({ Authorization: `Bearer ${token}` });

      expect(res.status).toBe(200);
      expect(res.body.data[0].credit_account.balance).toBeDefined();
      expect(typeof res.body.data[0].credit_account.balance).toBe('number');
    });

    it('does not attach balance when details filter is active', async () => {
      await pool.query(
        `INSERT INTO transactions (user_id, category_id, credit_account_id, debit, credit, currency, date, description)
         VALUES ($1, $2, $3, 5000, 5000, 'USD', '2026-03-01', 'Salary')`,
        [testUserId, incomeCategoryId, testAccountId]
      );

      const res = await request(app)
        .get('/api/transactions?details=Salary')
        .set({ Authorization: `Bearer ${token}` });

      expect(res.status).toBe(200);
      expect(res.body.data[0].credit_account.balance).toBeUndefined();
    });

    it('does not attach balance when category filter is active', async () => {
      await pool.query(
        `INSERT INTO transactions (user_id, category_id, credit_account_id, debit, credit, currency, date)
         VALUES ($1, $2, $3, 5000, 5000, 'USD', '2026-03-01')`,
        [testUserId, incomeCategoryId, testAccountId]
      );

      const res = await request(app)
        .get(`/api/transactions?category=${incomeCategoryId}`)
        .set({ Authorization: `Bearer ${token}` });

      expect(res.status).toBe(200);
      expect(res.body.data[0].credit_account.balance).toBeUndefined();
    });

    it('does not attach balance when type filter is active', async () => {
      await pool.query(
        `INSERT INTO transactions (user_id, category_id, credit_account_id, debit, credit, currency, date)
         VALUES ($1, $2, $3, 5000, 5000, 'USD', '2026-03-01')`,
        [testUserId, incomeCategoryId, testAccountId]
      );

      const res = await request(app)
        .get('/api/transactions?type=income')
        .set({ Authorization: `Bearer ${token}` });

      expect(res.status).toBe(200);
      expect(res.body.data[0].credit_account.balance).toBeUndefined();
    });

    it('computes correct running balances across multiple transactions', async () => {
      // Account starts at 0 (from beforeAll). Two incomes: 3000 then 2000.
      await pool.query(
        `INSERT INTO transactions (user_id, category_id, credit_account_id, debit, credit, currency, date, created_at)
         VALUES
           ($1, $2, $3, 3000, 3000, 'USD', '2026-03-01', '2026-03-01 09:00:00'),
           ($1, $2, $3, 2000, 2000, 'USD', '2026-03-10', '2026-03-10 09:00:00')`,
        [testUserId, incomeCategoryId, testAccountId]
      );

      const res = await request(app)
        .get('/api/transactions')
        .set({ Authorization: `Bearer ${token}` });

      expect(res.status).toBe(200);
      // Transactions arrive DESC: [Mar 10 (+2000), Mar 1 (+3000)]
      const [newer, older] = res.body.data;
      // After Mar 10: 0 + 3000 + 2000 = 5000
      expect(newer.credit_account.balance).toBe(5000);
      // After Mar 1: 0 + 3000 = 3000
      expect(older.credit_account.balance).toBe(3000);
    });

    it('computes correct balance on page 2 without including page 1 transactions', async () => {
      // Three incomes: 1000 (oldest), 2000 (middle), 3000 (newest)
      await pool.query(
        `INSERT INTO transactions (user_id, category_id, credit_account_id, debit, credit, currency, date, created_at)
         VALUES
           ($1, $2, $3, 1000, 1000, 'USD', '2026-04-01', '2026-04-01 08:00:00'),
           ($1, $2, $3, 2000, 2000, 'USD', '2026-04-10', '2026-04-10 08:00:00'),
           ($1, $2, $3, 3000, 3000, 'USD', '2026-04-20', '2026-04-20 08:00:00')`,
        [testUserId, incomeCategoryId, testAccountId]
      );

      // Page 2: offset=1, limit=1 → the middle transaction (2000 on Apr 10)
      const res = await request(app)
        .get('/api/transactions?offset=1&limit=1')
        .set({ Authorization: `Bearer ${token}` });

      expect(res.status).toBe(200);
      expect(res.body.data.length).toBe(1);
      // After Apr 10: 0 + 1000 + 2000 = 3000 (Apr 20 transaction is NOT included)
      expect(res.body.data[0].credit_account.balance).toBe(3000);
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
