import request from 'supertest';
import { createTestApp } from './testApp';
import { pool } from '../db';
import { LEVEL, AccessLevel } from '../services/access';

const app = createTestApp();

describe('Account sharing', () => {
  let tokenA: string;
  let tokenB: string;
  let userAId: number;
  let userBId: number;
  let a1: number; // owned by A, shared with B in most tests
  let a2: number; // owned by A, never shared
  let b1: number; // owned by B
  let expenseCategoryA: number;
  let expenseCategoryB: number;

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

  const expenseCategoryOf = async (userId: number) => {
    const res = await pool.query(
      `SELECT c.id FROM categories c
       JOIN categories p ON c.parent_id = p.id
       WHERE c.user_id = $1 AND p.id = 2 LIMIT 1`,
      [userId]
    );
    return res.rows[0].id as number;
  };

  const makeAccount = async (userId: number, name: string) => {
    const res = await pool.query(
      `INSERT INTO accounts (user_id, name, currency, start_balance, scale)
       VALUES ($1, $2, 'USD', 0, 2) RETURNING id`,
      [userId, name]
    );
    return res.rows[0].id as number;
  };

  const grant = async (accountId: number, userId: number, level: AccessLevel) => {
    await pool.query(
      `INSERT INTO account_shares (account_id, user_id, level) VALUES ($1, $2, $3)
       ON CONFLICT (account_id, user_id) DO UPDATE SET level = EXCLUDED.level`,
      [accountId, userId, level]
    );
  };

  const revoke = async (accountId: number, userId: number) => {
    await pool.query('DELETE FROM account_shares WHERE account_id = $1 AND user_id = $2', [accountId, userId]);
  };

  beforeAll(async () => {
    const stamp = Date.now();
    const a = await register(`share-a${stamp}@example.com`);
    const b = await register(`share-b${stamp}@example.com`);
    tokenA = a.token; userAId = a.id;
    tokenB = b.token; userBId = b.id;

    await pool.query('UPDATE users SET name = $1 WHERE id = $2', ['Alice', userAId]);

    a1 = await makeAccount(userAId, 'A One');
    a2 = await makeAccount(userAId, 'A Two');
    b1 = await makeAccount(userBId, 'B One');

    expenseCategoryA = await expenseCategoryOf(userAId);
    expenseCategoryB = await expenseCategoryOf(userBId);
  });

  afterAll(async () => {
    await pool.query('DELETE FROM account_shares WHERE account_id = ANY($1::int[])', [[a1, a2, b1]]);
    await pool.query('DELETE FROM transactions WHERE user_id = ANY($1::int[])', [[userAId, userBId]]);
    await pool.query('DELETE FROM accounts WHERE user_id = ANY($1::int[])', [[userAId, userBId]]);
    await pool.query('DELETE FROM categories WHERE user_id = ANY($1::int[])', [[userAId, userBId]]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [[userAId, userBId]]);
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM account_shares WHERE account_id = ANY($1::int[])', [[a1, a2, b1]]);
    await pool.query('DELETE FROM transactions WHERE user_id = ANY($1::int[])', [[userAId, userBId]]);
  });

  describe('visibility at level 1', () => {
    beforeEach(async () => {
      await grant(a1, userBId, LEVEL.READ);
    });

    it('returns nothing when the account filter names only unreachable accounts', async () => {
      // a2 is A's and was never shared. Asking for it explicitly must yield an
      // empty result — never an unfiltered one. This pins the empty-intersection
      // guard: the access list and the client filter are the same parameter, so
      // an empty intersection must mean "nothing", not "no filter".
      await pool.query(
        `INSERT INTO transactions (user_id, category_id, debit_account_id, debit, credit, date, description)
         VALUES ($1, $2, $3, 900, 900, '2026-03-01', 'On a2')`,
        [userAId, expenseCategoryA, a2]
      );

      const res = await request(app)
        .get(`/api/transactions?account=${a2}`)
        .set({ Authorization: `Bearer ${tokenB}` });

      expect(res.status).toBe(200);
      expect(res.body.data).toEqual([]);
    });

    it('drops unreachable ids from a mixed account filter', async () => {
      await pool.query(
        `INSERT INTO transactions (user_id, category_id, debit_account_id, debit, credit, date, description)
         VALUES ($1, $2, $3, 100, 100, '2026-03-01', 'On a1')`,
        [userAId, expenseCategoryA, a1]
      );
      await pool.query(
        `INSERT INTO transactions (user_id, category_id, debit_account_id, debit, credit, date, description)
         VALUES ($1, $2, $3, 200, 200, '2026-03-01', 'On a2')`,
        [userAId, expenseCategoryA, a2]
      );

      const res = await request(app)
        .get(`/api/transactions?account=${a1}&account=${a2}`)
        .set({ Authorization: `Bearer ${tokenB}` });

      const descriptions = res.body.data.map((t: { description: string }) => t.description);
      expect(descriptions).toContain('On a1');
      expect(descriptions).not.toContain('On a2');
    });

    it('shows the shared account to B with its level and owner name', async () => {
      const res = await request(app).get('/api/accounts').set({ Authorization: `Bearer ${tokenB}` });

      expect(res.status).toBe(200);
      const shared = res.body.data.find((a: { id: number }) => a.id === a1);
      expect(shared).toBeDefined();
      expect(shared.access_level).toBe(LEVEL.READ);
      expect(shared.owner_name).toBe('Alice');
    });

    it('does not show accounts that were not shared', async () => {
      const res = await request(app).get('/api/accounts').set({ Authorization: `Bearer ${tokenB}` });
      expect(res.body.data.find((a: { id: number }) => a.id === a2)).toBeUndefined();
    });

    it('marks the user\'s own accounts as OWNER', async () => {
      const res = await request(app).get('/api/accounts').set({ Authorization: `Bearer ${tokenB}` });
      const own = res.body.data.find((a: { id: number }) => a.id === b1);
      expect(own.access_level).toBe(LEVEL.OWNER);
    });

    it('shows B a transaction A created on the shared account', async () => {
      await pool.query(
        `INSERT INTO transactions (user_id, category_id, debit_account_id, debit, credit, date, description)
         VALUES ($1, $2, $3, 2500, 2500, '2026-03-01', 'Groceries')`,
        [userAId, expenseCategoryA, a1]
      );

      const res = await request(app).get('/api/transactions').set({ Authorization: `Bearer ${tokenB}` });

      expect(res.status).toBe(200);
      expect(res.body.data.map((t: { description: string }) => t.description)).toContain('Groceries');
    });

    it('reports the same balance to B as to A', async () => {
      await pool.query(
        `INSERT INTO transactions (user_id, category_id, debit_account_id, debit, credit, date)
         VALUES ($1, $2, $3, 2500, 2500, '2026-03-01')`,
        [userAId, expenseCategoryA, a1]
      );

      const resA = await request(app).get('/api/accounts').set({ Authorization: `Bearer ${tokenA}` });
      const resB = await request(app).get('/api/accounts').set({ Authorization: `Bearer ${tokenB}` });

      const balA = resA.body.data.find((a: { id: number }) => a.id === a1).balance;
      const balB = resB.body.data.find((a: { id: number }) => a.id === a1).balance;
      expect(balB).toBe(balA);
      expect(balA).toBe(-25);
    });
  });

  describe('level boundaries', () => {
    const expensePayload = () => ({
      debitAccountId: a1,
      categoryId: expenseCategoryB,
      debit: 10,
      credit: 10,
      date: '2026-03-02',
      description: 'By B',
    });

    const accountPayload = () => ({ name: 'Renamed', type: 'cash' as const, settings: {} });

    it('level 1 cannot create, update, or delete transactions', async () => {
      await grant(a1, userBId, LEVEL.READ);

      const created = await request(app)
        .post('/api/transactions')
        .set({ Authorization: `Bearer ${tokenB}` })
        .send(expensePayload());
      expect(created.status).toBe(403);

      const existing = await pool.query(
        `INSERT INTO transactions (user_id, category_id, debit_account_id, debit, credit, date)
         VALUES ($1, $2, $3, 500, 500, '2026-03-02') RETURNING id`,
        [userAId, expenseCategoryA, a1]
      );
      const txId = existing.rows[0].id;

      const updated = await request(app)
        .put(`/api/transactions/${txId}`)
        .set({ Authorization: `Bearer ${tokenB}` })
        .send({ description: 'hacked' });
      expect(updated.status).toBe(403);

      const deleted = await request(app)
        .delete(`/api/transactions/${txId}`)
        .set({ Authorization: `Bearer ${tokenB}` });
      expect(deleted.status).toBe(403);
    });

    it('level 2 can manage transactions but not edit the account', async () => {
      await grant(a1, userBId, LEVEL.WRITE);

      const created = await request(app)
        .post('/api/transactions')
        .set({ Authorization: `Bearer ${tokenB}` })
        .send(expensePayload());
      expect(created.status).toBe(200);
      expect(created.body.data.id).toBeDefined();

      const updated = await request(app)
        .put(`/api/transactions/${created.body.data.id}`)
        .set({ Authorization: `Bearer ${tokenB}` })
        .send({ description: 'Edited by B' });
      expect(updated.status).toBe(200);
      expect(updated.body.data.description).toBe('Edited by B');

      const deleted = await request(app)
        .delete(`/api/transactions/${created.body.data.id}`)
        .set({ Authorization: `Bearer ${tokenB}` });
      expect(deleted.status).toBe(200);

      const edited = await request(app)
        .put(`/api/accounts/${a1}`)
        .set({ Authorization: `Bearer ${tokenB}` })
        .send(accountPayload());
      expect(edited.status).toBe(403);
    });

    it('level 2 can edit a transaction the owner authored', async () => {
      await grant(a1, userBId, LEVEL.WRITE);

      const existing = await pool.query(
        `INSERT INTO transactions (user_id, category_id, debit_account_id, debit, credit, date, description)
         VALUES ($1, $2, $3, 500, 500, '2026-03-02', 'Original') RETURNING id`,
        [userAId, expenseCategoryA, a1]
      );
      const txId = existing.rows[0].id;

      const updated = await request(app)
        .put(`/api/transactions/${txId}`)
        .set({ Authorization: `Bearer ${tokenB}` })
        .send({ description: 'Edited by B' });
      expect(updated.status).toBe(200);
      expect(updated.body.data.description).toBe('Edited by B');

      // B must still not be able to attach B's own category to A's transaction.
      const recategorized = await request(app)
        .put(`/api/transactions/${txId}`)
        .set({ Authorization: `Bearer ${tokenB}` })
        .send({ categoryId: expenseCategoryB });
      expect(recategorized.status).toBe(403);
    });

    it('level 3 can edit the account but not delete it', async () => {
      await grant(a1, userBId, LEVEL.ADMIN);

      try {
        const edited = await request(app)
          .put(`/api/accounts/${a1}`)
          .set({ Authorization: `Bearer ${tokenB}` })
          .send(accountPayload());
        expect(edited.status).toBe(200);
        expect(edited.body.data.name).toBe('Renamed');

        const removed = await request(app)
          .delete(`/api/accounts/${a1}`)
          .set({ Authorization: `Bearer ${tokenB}` });
        expect(removed.status).toBe(403);
      } finally {
        // restore the name for the remaining tests, even if an assertion above threw
        await pool.query('UPDATE accounts SET name = $1 WHERE id = $2', ['A One', a1]);
      }
    });

    it('the owner can delete their own account', async () => {
      const throwaway = await makeAccount(userAId, 'Throwaway');
      const removed = await request(app)
        .delete(`/api/accounts/${throwaway}`)
        .set({ Authorization: `Bearer ${tokenA}` });
      expect(removed.status).toBe(200);
      expect(removed.body.data.kind).toBe('hard-deleted');
    });
  });

  describe('transfers across an access boundary', () => {
    const transfer = () => ({
      debitAccountId: a1,
      creditAccountId: b1,
      debit: 30,
      credit: 30,
      date: '2026-03-03',
      description: 'A1 to B1',
    });

    it('allows the transfer with write access on both accounts and shows it to both users', async () => {
      await grant(a1, userBId, LEVEL.WRITE);

      const created = await request(app)
        .post('/api/transactions')
        .set({ Authorization: `Bearer ${tokenB}` })
        .send(transfer());
      expect(created.status).toBe(200);

      const seenByA = await request(app).get('/api/transactions').set({ Authorization: `Bearer ${tokenA}` });
      const rowA = seenByA.body.data.find((t: { description: string }) => t.description === 'A1 to B1');
      expect(rowA).toBeDefined();
      // A sees the far side in full, including B's private account name.
      expect(rowA.credit_account.name).toBe('B One');

      const seenByB = await request(app).get('/api/transactions').set({ Authorization: `Bearer ${tokenB}` });
      expect(seenByB.body.data.map((t: { description: string }) => t.description)).toContain('A1 to B1');
    });

    it('rejects the transfer when write access is missing on one side', async () => {
      await grant(a1, userBId, LEVEL.READ);

      const created = await request(app)
        .post('/api/transactions')
        .set({ Authorization: `Bearer ${tokenB}` })
        .send(transfer());
      expect(created.status).toBe(403);
    });

    it('rejects moving a transaction onto an account the user cannot reach', async () => {
      await grant(a1, userBId, LEVEL.WRITE);

      const created = await request(app)
        .post('/api/transactions')
        .set({ Authorization: `Bearer ${tokenB}` })
        .send({
          debitAccountId: a1,
          categoryId: expenseCategoryB,
          debit: 10,
          credit: 10,
          date: '2026-03-04',
        });
      expect(created.status).toBe(200);

      const moved = await request(app)
        .put(`/api/transactions/${created.body.data.id}`)
        .set({ Authorization: `Bearer ${tokenB}` })
        .send({ debitAccountId: a2 });
      expect(moved.status).toBe(403);
    });

    it('does not expose the balance of a counterparty account the viewer cannot reach', async () => {
      await grant(a1, userBId, LEVEL.WRITE);

      const created = await request(app)
        .post('/api/transactions')
        .set({ Authorization: `Bearer ${tokenB}` })
        .send(transfer());
      expect(created.status).toBe(200);

      // A owns a1 but cannot reach b1.
      const seenByA = await request(app).get('/api/transactions').set({ Authorization: `Bearer ${tokenA}` });
      const row = seenByA.body.data.find((t: { description: string }) => t.description === 'A1 to B1');
      expect(row).toBeDefined();
      expect(row.credit_account.name).toBe('B One');        // name is visible by design
      expect(row.credit_account.balance).toBeUndefined();   // balance must NOT be
      expect(typeof row.debit_account.balance).toBe('number'); // own side still has one
    });
  });

  describe('revocation', () => {
    it('hides the account and its transactions, but keeps shared transfers visible through the user\'s own side', async () => {
      await grant(a1, userBId, LEVEL.WRITE);

      await pool.query(
        `INSERT INTO transactions (user_id, category_id, debit_account_id, debit, credit, date, description)
         VALUES ($1, $2, $3, 700, 700, '2026-03-05', 'A only')`,
        [userAId, expenseCategoryA, a1]
      );
      const transferRes = await request(app)
        .post('/api/transactions')
        .set({ Authorization: `Bearer ${tokenB}` })
        .send({
          debitAccountId: a1,
          creditAccountId: b1,
          debit: 30,
          credit: 30,
          date: '2026-03-06',
          description: 'Shared transfer',
        });
      expect(transferRes.status).toBe(200);

      await revoke(a1, userBId);

      const accounts = await request(app).get('/api/accounts').set({ Authorization: `Bearer ${tokenB}` });
      expect(accounts.body.data.find((a: { id: number }) => a.id === a1)).toBeUndefined();

      const txs = await request(app).get('/api/transactions').set({ Authorization: `Bearer ${tokenB}` });
      const descriptions = txs.body.data.map((t: { description: string }) => t.description);
      expect(descriptions).not.toContain('A only');
      // The transfer still touches B's own account, so it stays visible.
      expect(descriptions).toContain('Shared transfer');

      const seenByA = await request(app).get('/api/transactions').set({ Authorization: `Bearer ${tokenA}` });
      expect(seenByA.body.data.map((t: { description: string }) => t.description)).toContain('Shared transfer');
    });

    it('stops a revoked user from writing to the account', async () => {
      await grant(a1, userBId, LEVEL.WRITE);
      await revoke(a1, userBId);

      const created = await request(app)
        .post('/api/transactions')
        .set({ Authorization: `Bearer ${tokenB}` })
        .send({
          debitAccountId: a1,
          categoryId: expenseCategoryB,
          debit: 10,
          credit: 10,
          date: '2026-03-07',
        });
      expect(created.status).toBe(403);
    });
  });
});
