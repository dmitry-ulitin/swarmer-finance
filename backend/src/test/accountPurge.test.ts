import request from 'supertest';
import { createTestApp } from './testApp';
import { pool } from '../db';
import { LEVEL, AccessLevel } from '../services/access';

const app = createTestApp();

describe('Account purge', () => {
  let tokenA: string;
  let tokenB: string;
  let userAId: number;
  let userBId: number;
  let expenseCategoryA: number;
  let accountIds: number[] = [];

  // GET /api/accounts performs currency conversion, which would otherwise
  // reach the real Frankfurter API.
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

  const register = async (email: string) => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email, password: 'password123' });
    const user = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    return { token: res.body.data.accessToken as string, id: user.rows[0].id as number };
  };

  const makeAccount = async (userId: number, name: string, currency = 'USD') => {
    const res = await pool.query(
      `INSERT INTO accounts (user_id, name, currency, start_balance, scale)
       VALUES ($1, $2, $3, 0, 2) RETURNING id`,
      [userId, name, currency]
    );
    accountIds.push(res.rows[0].id);
    return res.rows[0].id as number;
  };

  const grant = async (accountId: number, userId: number, level: AccessLevel) => {
    await pool.query(
      'INSERT INTO account_shares (account_id, user_id, level) VALUES ($1, $2, $3)',
      [accountId, userId, level]
    );
  };

  const insertTx = async (fields: {
    debitAccountId?: number; creditAccountId?: number; debit: number; credit: number;
    categoryId?: number; importHash?: string;
  }) => {
    const res = await pool.query(
      `INSERT INTO transactions
         (user_id, category_id, debit_account_id, credit_account_id, debit, credit, date, description, payee, import_hash)
       VALUES ($1, $2, $3, $4, $5, $6, '2026-09-01', 'note', 'payee', $7) RETURNING id`,
      [userAId, fields.categoryId ?? null, fields.debitAccountId ?? null, fields.creditAccountId ?? null,
        fields.debit, fields.credit, fields.importHash ?? null]
    );
    return res.rows[0].id as number;
  };

  const txRow = async (id: number) =>
    (await pool.query('SELECT * FROM transactions WHERE id = $1', [id])).rows[0];

  const countFor = async (accountId: number) =>
    Number((await pool.query(
      'SELECT COUNT(*) FROM transactions WHERE debit_account_id = $1 OR credit_account_id = $1',
      [accountId]
    )).rows[0].count);

  beforeAll(async () => {
    const stamp = Date.now();
    const a = await register(`purge-a${stamp}@example.com`);
    const b = await register(`purge-b${stamp}@example.com`);
    tokenA = a.token; userAId = a.id;
    tokenB = b.token; userBId = b.id;
    const res = await pool.query(
      `SELECT c.id FROM categories c JOIN categories p ON c.parent_id = p.id
       WHERE c.user_id = $1 AND p.id = 2 LIMIT 1`,
      [userAId]
    );
    expenseCategoryA = res.rows[0].id;
  });

  afterEach(async () => {
    await pool.query('DELETE FROM transactions WHERE user_id = ANY($1::int[])', [[userAId, userBId]]);
    await pool.query('DELETE FROM accounts WHERE id = ANY($1::int[])', [accountIds]);
    accountIds = [];
  });

  afterAll(async () => {
    await pool.query('DELETE FROM categories WHERE user_id = ANY($1::int[])', [[userAId, userBId]]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [[userAId, userBId]]);
  });

  const purge = (id: number, token = tokenA) =>
    request(app).delete(`/api/accounts/${id}/transactions`).set({ Authorization: `Bearer ${token}` });

  const deleteWithTransactions = (id: number, token = tokenA) =>
    request(app).delete(`/api/accounts/${id}?withTransactions=true`).set({ Authorization: `Bearer ${token}` });

  describe('DELETE /api/accounts/:id/transactions', () => {
    it('deletes the account\'s own expenses and income and keeps the account', async () => {
      const acc = await makeAccount(userAId, 'Test');
      const other = await makeAccount(userAId, 'Other');
      await insertTx({ debitAccountId: acc, debit: 500, credit: 500, categoryId: expenseCategoryA });
      await insertTx({ creditAccountId: acc, debit: 700, credit: 700, categoryId: 3 });
      const untouched = await insertTx({ debitAccountId: other, debit: 100, credit: 100, categoryId: expenseCategoryA });

      const res = await purge(acc);

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ deleted: 2, detached: 0 });
      expect(await countFor(acc)).toBe(0);
      expect(await txRow(untouched)).toBeDefined();
      const account = await pool.query('SELECT deleted FROM accounts WHERE id = $1', [acc]);
      expect(account.rows[0].deleted).toBe(false);
    });

    it('turns a transfer out of the account into uncategorized income on the receiver', async () => {
      const acc = await makeAccount(userAId, 'Test', 'USD');
      const other = await makeAccount(userAId, 'Other', 'EUR');
      const id = await insertTx({ debitAccountId: acc, creditAccountId: other, debit: 1000, credit: 900, importHash: 'h1' });

      const res = await purge(acc);

      expect(res.body.data).toEqual({ deleted: 0, detached: 1 });
      const row = await txRow(id);
      expect(row.debit_account_id).toBeNull();
      expect(row.credit_account_id).toBe(other);
      expect(Number(row.debit)).toBe(900);
      expect(Number(row.credit)).toBe(900);
      expect(row.category_id).toBe(3);
      expect(row.description).toBe('note');
      expect(row.payee).toBe('payee');
      expect(row.import_hash).toBe('h1');
    });

    it('turns a transfer into the account into uncategorized expense on the sender', async () => {
      const acc = await makeAccount(userAId, 'Test', 'USD');
      const other = await makeAccount(userAId, 'Other', 'EUR');
      const id = await insertTx({ debitAccountId: other, creditAccountId: acc, debit: 900, credit: 1000 });

      await purge(acc);

      const row = await txRow(id);
      expect(row.debit_account_id).toBe(other);
      expect(row.credit_account_id).toBeNull();
      expect(Number(row.debit)).toBe(900);
      expect(Number(row.credit)).toBe(900);
      expect(row.category_id).toBe(4);
    });

    it('forgets the chain txids the account has synced', async () => {
      const acc = await makeAccount(userAId, 'Test');
      await pool.query(`INSERT INTO chain_seen_txids (account_id, txid) VALUES ($1, 'aa'), ($1, 'bb')`, [acc]);

      await purge(acc);

      const seen = await pool.query('SELECT COUNT(*) FROM chain_seen_txids WHERE account_id = $1', [acc]);
      expect(Number(seen.rows[0].count)).toBe(0);
    });

    it('requires admin on the account', async () => {
      const acc = await makeAccount(userAId, 'Test');
      await grant(acc, userBId, LEVEL.WRITE);
      await insertTx({ debitAccountId: acc, debit: 500, credit: 500, categoryId: expenseCategoryA });

      const res = await purge(acc, tokenB);

      expect(res.status).toBe(403);
      expect(await countFor(acc)).toBe(1);
    });

    it('allows a co-owner with admin', async () => {
      const acc = await makeAccount(userAId, 'Test');
      await grant(acc, userBId, LEVEL.ADMIN);
      await insertTx({ debitAccountId: acc, debit: 500, credit: 500, categoryId: expenseCategoryA });

      const res = await purge(acc, tokenB);

      expect(res.status).toBe(200);
      expect(await countFor(acc)).toBe(0);
    });

    it('refuses, changing nothing, when a transfer\'s other account is not writable', async () => {
      const acc = await makeAccount(userAId, 'Test');
      const foreign = await makeAccount(userAId, 'Foreign');
      await grant(acc, userBId, LEVEL.ADMIN);
      await grant(foreign, userBId, LEVEL.READ);
      await insertTx({ debitAccountId: acc, debit: 500, credit: 500, categoryId: expenseCategoryA });
      const transfer = await insertTx({ debitAccountId: acc, creditAccountId: foreign, debit: 100, credit: 100 });

      const res = await purge(acc, tokenB);

      expect(res.status).toBe(403);
      expect(await countFor(acc)).toBe(2);
      expect((await txRow(transfer)).debit_account_id).toBe(acc);
    });

    it('returns 404 for a soft-deleted account', async () => {
      const acc = await makeAccount(userAId, 'Test');
      await pool.query('UPDATE accounts SET deleted = true WHERE id = $1', [acc]);

      const res = await purge(acc);

      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /api/accounts/:id?withTransactions=true', () => {
    it('removes the account, its transactions and its shares, detaching transfers', async () => {
      const acc = await makeAccount(userAId, 'Test');
      const other = await makeAccount(userAId, 'Other');
      await grant(acc, userBId, LEVEL.READ);
      await insertTx({ debitAccountId: acc, debit: 500, credit: 500, categoryId: expenseCategoryA });
      const transfer = await insertTx({ debitAccountId: acc, creditAccountId: other, debit: 100, credit: 100 });

      const res = await deleteWithTransactions(acc);

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ success: true, kind: 'purged', deleted: 1, detached: 1 });
      expect((await pool.query('SELECT 1 FROM accounts WHERE id = $1', [acc])).rowCount).toBe(0);
      expect((await pool.query('SELECT 1 FROM account_shares WHERE account_id = $1', [acc])).rowCount).toBe(0);
      const row = await txRow(transfer);
      expect(row.debit_account_id).toBeNull();
      expect(row.credit_account_id).toBe(other);
    });

    it('requires admin on the account', async () => {
      const acc = await makeAccount(userAId, 'Test');
      await grant(acc, userBId, LEVEL.WRITE);

      const res = await deleteWithTransactions(acc, tokenB);

      expect(res.status).toBe(403);
      expect((await pool.query('SELECT 1 FROM accounts WHERE id = $1', [acc])).rowCount).toBe(1);
    });
  });
});
