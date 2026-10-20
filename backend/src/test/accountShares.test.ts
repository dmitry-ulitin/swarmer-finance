import request from 'supertest';
import { createTestApp } from './testApp';
import { pool } from '../db';
import { AccessLevel } from '../services/access';

const app = createTestApp();

describe('Account share management', () => {
  let tokenA: string;
  let tokenB: string;
  let tokenC: string;
  let aId: number;
  let bId: number;
  let cId: number;
  let aEmail: string;
  let bEmail: string;
  let cEmail: string;
  let acc: number; // owned by A

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

  const list = (token: string) =>
    request(app).get(`/api/accounts/${acc}/shares`).set('Authorization', `Bearer ${token}`);
  const add = (token: string, email: string, level: unknown) =>
    request(app)
      .post(`/api/accounts/${acc}/shares`)
      .set('Authorization', `Bearer ${token}`)
      .send({ email, level });
  const setLevel = (token: string, target: number, level: unknown) =>
    request(app)
      .put(`/api/accounts/${acc}/shares/${target}`)
      .set('Authorization', `Bearer ${token}`)
      .send({ level });
  const remove = (token: string, target: number) =>
    request(app)
      .delete(`/api/accounts/${acc}/shares/${target}`)
      .set('Authorization', `Bearer ${token}`);
  // A user-owned child category of a system root, returning its id.
  const makeCategory = async (userId: number, name: string, parentId: number) => {
    const res = await pool.query(
      'INSERT INTO categories (user_id, name, parent_id) VALUES ($1, $2, $3) RETURNING id',
      [userId, name, parentId]
    );
    return res.rows[0].id as number;
  };

  beforeAll(async () => {
    const stamp = Date.now();
    aEmail = `ashare-a${stamp}@example.com`;
    bEmail = `ashare-b${stamp}@example.com`;
    cEmail = `ashare-c${stamp}@example.com`;
    const a = await register(aEmail);
    const b = await register(bEmail);
    const c = await register(cEmail);
    tokenA = a.token; aId = a.id;
    tokenB = b.token; bId = b.id;
    tokenC = c.token; cId = c.id;

    await pool.query('UPDATE users SET name = $1 WHERE id = $2', ['Alice', aId]);
    await pool.query('UPDATE users SET name = $1 WHERE id = $2', ['Bob', bId]);
    await pool.query('UPDATE users SET name = $1 WHERE id = $2', ['Carol', cId]);

    acc = await makeAccount(aId, 'Shared');
  });

  afterAll(async () => {
    await pool.query('DELETE FROM account_shares WHERE account_id = $1', [acc]);
    await pool.query(
      `DELETE FROM transactions WHERE debit_account_id IN (SELECT id FROM accounts WHERE user_id = ANY($1::int[]))
          OR credit_account_id IN (SELECT id FROM accounts WHERE user_id = ANY($1::int[]))`,
      [[aId, bId, cId]]
    );
    await pool.query('DELETE FROM account_shares WHERE user_id = ANY($1::int[])', [[aId, bId, cId]]);
    await pool.query('DELETE FROM accounts WHERE user_id = ANY($1::int[])', [[aId, bId, cId]]);
    await pool.query('DELETE FROM categories WHERE user_id = ANY($1::int[])', [[aId, bId, cId]]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [[aId, bId, cId]]);
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM account_shares WHERE account_id = $1', [acc]);
    // Some tests move ownership away from A.
    await pool.query('UPDATE accounts SET user_id = $1 WHERE id = $2', [aId, acc]);
  });

  it('lists the creator and shares for a level-1 member', async () => {
    await grant(acc, bId, 1);
    const res = await list(tokenB);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      { user_id: aId, name: 'Alice', email: aEmail, level: 4, is_creator: true },
      { user_id: bId, name: 'Bob', email: bEmail, level: 1, is_creator: false },
    ]);
  });

  it('403 listing without access', async () => {
    const res = await list(tokenC);
    expect(res.status).toBe(403);
  });

  it('adds by email, case-insensitive and trimmed', async () => {
    const res = await add(tokenA, `  ${cEmail.toUpperCase()} `, 2);
    expect(res.status).toBe(200);
    expect(res.body.data).toContainEqual(
      { user_id: cId, name: 'Carol', email: cEmail, level: 2, is_creator: false }
    );
  });

  it('404 for unknown email', async () => {
    const res = await add(tokenA, 'nobody-here@example.com', 1);
    expect(res.status).toBe(404);
    expect(res.body.error).toBe('No user with this email');
  });

  it('400 sharing with yourself', async () => {
    const res = await add(tokenA, aEmail, 1);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Cannot share an account with yourself');
  });

  it('409 for an existing member', async () => {
    await grant(acc, bId, 1);
    const res = await add(tokenA, bEmail, 2);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('This user already has access');
  });

  it('409 when the email is the creator', async () => {
    await grant(acc, bId, 3);
    const res = await add(tokenB, aEmail, 1);
    expect(res.status).toBe(409);
    expect(res.body.error).toBe('This user already has access');
  });

  it('403 adding at level 2', async () => {
    await grant(acc, bId, 2);
    const res = await add(tokenB, cEmail, 1);
    expect(res.status).toBe(403);
  });

  it('granting co-owner makes the creator level 3', async () => {
    const res = await add(tokenA, bEmail, 3);
    expect(res.status).toBe(200);
    expect(res.body.data[0]).toMatchObject({ user_id: aId, level: 3, is_creator: true });

    const accounts = await request(app).get('/api/accounts').set('Authorization', `Bearer ${tokenA}`);
    const found = accounts.body.data.find((x: { id: number }) => x.id === acc);
    expect(found.access_level).toBe(3);
  });

  it('400 for level 4 in the body', async () => {
    const res = await add(tokenA, cEmail, 4);
    expect(res.status).toBe(400);
  });

  it('co-owner changes a member level', async () => {
    await grant(acc, bId, 1);
    const res = await setLevel(tokenA, bId, 2);
    expect(res.status).toBe(200);
    expect(res.body.data).toContainEqual(
      { user_id: bId, name: 'Bob', email: bEmail, level: 2, is_creator: false }
    );
  });

  it('400 for level 4 when changing a level', async () => {
    await grant(acc, bId, 1);
    const res = await setLevel(tokenA, bId, 4);
    expect(res.status).toBe(400);
  });

  it('403 changing or removing at level 2', async () => {
    await grant(acc, bId, 2);
    await grant(acc, cId, 1);
    expect((await setLevel(tokenB, cId, 2)).status).toBe(403);
    expect((await remove(tokenB, cId)).status).toBe(403);
  });

  it('404 for a non-member target', async () => {
    const put = await setLevel(tokenA, cId, 2);
    expect(put.status).toBe(404);
    expect(put.body.error).toBe('Not a member of this account');
    const del = await remove(tokenA, cId);
    expect(del.status).toBe(404);
    expect(del.body.error).toBe('Not a member of this account');
  });

  it('member leaves at level 1', async () => {
    await grant(acc, bId, 1);
    const res = await remove(tokenB, bId);
    expect(res.status).toBe(200);
    const accounts = await request(app).get('/api/accounts').set('Authorization', `Bearer ${tokenB}`);
    expect(accounts.body.data.map((x: { id: number }) => x.id)).not.toContain(acc);
  });

  it('removing the last co-owner makes it personal again', async () => {
    await grant(acc, bId, 3);
    const res = await remove(tokenA, bId);
    expect(res.status).toBe(200);
    const accounts = await request(app).get('/api/accounts').set('Authorization', `Bearer ${tokenA}`);
    const found = accounts.body.data.find((x: { id: number }) => x.id === acc);
    expect(found.access_level).toBe(4);
  });

  it('removed member history moves to the owner', async () => {
    await grant(acc, bId, 2);
    // Registration seeds 'Food' for every user, A included, so the copy
    // lands under A's existing 'Food'.
    const foodRow = await pool.query(
      `SELECT id FROM categories WHERE user_id = $1 AND name = 'Food' AND parent_id = 2`, [bId]
    );
    const food = foodRow.rows[0].id as number;
    const lunch = await makeCategory(bId, 'Lunch', food);
    const bAcc = await makeAccount(bId, 'B own');

    const expense = await request(app)
      .post('/api/transactions')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ debitAccountId: acc, categoryId: lunch, debit: 5, credit: 5, date: '2026-03-02', description: 'Lunch by B' });
    expect(expense.status).toBe(200);
    const expenseId = expense.body.data.id as number;

    const transfer = await request(app)
      .post('/api/transactions')
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ debitAccountId: acc, creditAccountId: bAcc, debit: 3, credit: 3, date: '2026-03-02', description: 'To B' });
    expect(transfer.status).toBe(200);
    const transferId = transfer.body.data.id as number;

    const res = await remove(tokenA, bId);
    expect(res.status).toBe(200);

    const row = await pool.query('SELECT user_id, category_id FROM transactions WHERE id = $1', [expenseId]);
    expect(row.rows[0].user_id).toBe(aId);
    // The category now belongs to A under the same path.
    const cat = await pool.query('SELECT user_id, name FROM categories WHERE id = $1', [row.rows[0].category_id]);
    expect(cat.rows[0]).toEqual({ user_id: aId, name: 'Lunch' });
    const parent = await pool.query(
      'SELECT p.user_id, p.name FROM categories c JOIN categories p ON p.id = c.parent_id WHERE c.id = $1',
      [row.rows[0].category_id]
    );
    expect(parent.rows[0]).toEqual({ user_id: aId, name: 'Food' });

    // A can re-categorise it to one of A's own categories.
    const aCat = await makeCategory(aId, 'A groceries', 2);
    const edited = await request(app)
      .put(`/api/transactions/${expenseId}`)
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ categoryId: aCat });
    expect(edited.status).toBe(200);

    const transferRow = await pool.query('SELECT user_id FROM transactions WHERE id = $1', [transferId]);
    expect(transferRow.rows[0].user_id).toBe(bId);
  });

  it('third-party category does not block removal', async () => {
    await grant(acc, bId, 2);
    // C shares an account with B, so B could legitimately use C's category.
    const cAcc = await makeAccount(cId, 'C shared');
    await grant(cAcc, bId, 2);
    const cCat = await makeCategory(cId, 'Carol stuff', 2);
    const inserted = await pool.query(
      `INSERT INTO transactions (user_id, category_id, debit_account_id, debit, credit, date)
       VALUES ($1, $2, $3, 700, 700, '2026-03-03') RETURNING id`,
      [bId, cCat, acc]
    );

    const res = await remove(tokenA, bId);
    expect(res.status).toBe(200);

    const row = await pool.query(
      `SELECT t.user_id, c.user_id AS cat_owner, c.name FROM transactions t
         JOIN categories c ON c.id = t.category_id WHERE t.id = $1`,
      [inserted.rows[0].id]
    );
    expect(row.rows[0]).toEqual({ user_id: aId, cat_owner: aId, name: 'Carol stuff' });
  });

  it('system categories pass through unchanged', async () => {
    await grant(acc, bId, 2);
    const inserted = await pool.query(
      `INSERT INTO transactions (user_id, category_id, debit_account_id, debit, credit, date)
       VALUES ($1, 4, $2, 100, 100, '2026-03-04') RETURNING id`,
      [bId, acc]
    );
    expect((await remove(tokenA, bId)).status).toBe(200);
    const row = await pool.query('SELECT user_id, category_id FROM transactions WHERE id = $1', [inserted.rows[0].id]);
    expect(row.rows[0]).toEqual({ user_id: aId, category_id: 4 });
  });
  const accessLevel = async (token: string): Promise<number | undefined> => {
    const accounts = await request(app).get('/api/accounts').set('Authorization', `Bearer ${token}`);
    return accounts.body.data.find((x: { id: number }) => x.id === acc)?.access_level;
  };
  const ownerOf = async (): Promise<number> =>
    (await pool.query('SELECT user_id FROM accounts WHERE id = $1', [acc])).rows[0].user_id;

  it('co-owner removes the creator and becomes owner', async () => {
    await grant(acc, bId, 3);
    const res = await remove(tokenB, aId);
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual([
      { user_id: bId, name: 'Bob', email: bEmail, level: 4, is_creator: true },
    ]);
    expect(await ownerOf()).toBe(bId);
    expect(await accessLevel(tokenA)).toBeUndefined();
    expect(await accessLevel(tokenB)).toBe(4);
  });

  it('creator downgrades self on a co-owned account', async () => {
    await pool.query(
      `INSERT INTO account_shares (account_id, user_id, level, created_at) VALUES
         ($1, $2, 3, now() - interval '2 days'), ($1, $3, 3, now() - interval '1 day')`,
      [acc, bId, cId]
    );
    const res = await setLevel(tokenA, aId, 1);
    expect(res.status).toBe(200);
    expect(await ownerOf()).toBe(bId);
    expect(res.body.data).toEqual([
      { user_id: bId, name: 'Bob', email: bEmail, level: 3, is_creator: true },
      { user_id: cId, name: 'Carol', email: cEmail, level: 3, is_creator: false },
      { user_id: aId, name: 'Alice', email: aEmail, level: 1, is_creator: false },
    ]);
  });

  it('personal-account owner cannot leave or downgrade', async () => {
    await grant(acc, bId, 2);
    const del = await remove(tokenA, aId);
    expect(del.status).toBe(400);
    expect(del.body.error).toBe('Delete the account instead');
    const put = await setLevel(tokenA, aId, 1);
    expect(put.status).toBe(400);
    expect(put.body.error).toBe('Delete the account instead');
    expect(await ownerOf()).toBe(aId);
  });

  it('creator history moves to the new owner on removal', async () => {
    const foodRow = await pool.query(
      `SELECT id FROM categories WHERE user_id = $1 AND name = 'Food' AND parent_id = 2`, [aId]
    );
    const snacks = await makeCategory(aId, 'Snacks', foodRow.rows[0].id);
    const expense = await request(app)
      .post('/api/transactions')
      .set('Authorization', `Bearer ${tokenA}`)
      .send({ debitAccountId: acc, categoryId: snacks, debit: 2, credit: 2, date: '2026-03-05', description: 'Snacks by A' });
    expect(expense.status).toBe(200);

    await grant(acc, bId, 3);
    expect((await remove(tokenB, aId)).status).toBe(200);

    const row = await pool.query('SELECT user_id, category_id FROM transactions WHERE id = $1', [expense.body.data.id]);
    expect(row.rows[0].user_id).toBe(bId);
    const cat = await pool.query(
      `SELECT c.user_id, c.name, p.user_id AS parent_owner, p.name AS parent_name
         FROM categories c JOIN categories p ON p.id = c.parent_id WHERE c.id = $1`,
      [row.rows[0].category_id]
    );
    expect(cat.rows[0]).toEqual({ user_id: bId, name: 'Snacks', parent_owner: bId, parent_name: 'Food' });
  });

  it('co-owner downgrades the creator and becomes owner', async () => {
    await grant(acc, bId, 3);
    const res = await setLevel(tokenB, aId, 2);
    expect(res.status).toBe(200);
    expect(await ownerOf()).toBe(bId);
    expect(res.body.data).toEqual([
      { user_id: bId, name: 'Bob', email: bEmail, level: 4, is_creator: true },
      { user_id: aId, name: 'Alice', email: aEmail, level: 2, is_creator: false },
    ]);
  });

  it('creator removes self from a co-owned account', async () => {
    await pool.query(
      `INSERT INTO account_shares (account_id, user_id, level, created_at) VALUES
         ($1, $2, 3, now() - interval '2 days'), ($1, $3, 3, now() - interval '1 day')`,
      [acc, bId, cId]
    );
    const inserted = await pool.query(
      `INSERT INTO transactions (user_id, category_id, debit_account_id, debit, credit, date)
       VALUES ($1, 4, $2, 150, 150, '2026-03-06') RETURNING id`,
      [aId, acc]
    );
    const res = await remove(tokenA, aId);
    expect(res.status).toBe(200);
    expect(await ownerOf()).toBe(bId);
    expect(res.body.data).toEqual([
      { user_id: bId, name: 'Bob', email: bEmail, level: 3, is_creator: true },
      { user_id: cId, name: 'Carol', email: cEmail, level: 3, is_creator: false },
    ]);
    const row = await pool.query('SELECT user_id FROM transactions WHERE id = $1', [inserted.rows[0].id]);
    expect(row.rows[0].user_id).toBe(bId);
  });

  it("another author's rows with the departing creator's category stay theirs", async () => {
    const aCat = await makeCategory(aId, 'Imported by B', 2);
    // A bank import by co-owner B resolves categories against the creator.
    const inserted = await pool.query(
      `INSERT INTO transactions (user_id, category_id, debit_account_id, debit, credit, date)
       VALUES ($1, $2, $3, 400, 400, '2026-03-07') RETURNING id`,
      [bId, aCat, acc]
    );
    const id = inserted.rows[0].id as number;
    await grant(acc, bId, 3);
    expect((await remove(tokenB, aId)).status).toBe(200);

    const row = await pool.query(
      `SELECT t.user_id, c.user_id AS cat_owner, c.name, c.parent_id FROM transactions t
         JOIN categories c ON c.id = t.category_id WHERE t.id = $1`,
      [id]
    );
    expect(row.rows[0]).toEqual({ user_id: bId, cat_owner: bId, name: 'Imported by B', parent_id: 2 });

    const edited = await request(app)
      .put(`/api/transactions/${id}`)
      .set('Authorization', `Bearer ${tokenB}`)
      .send({ description: 'renamed' });
    expect(edited.status).toBe(200);
  });

  it("another member's rows with the departing member's category move to their own tree", async () => {
    await grant(acc, bId, 2);
    await grant(acc, cId, 2);
    const bCat = await makeCategory(bId, 'Bob tag', 2);
    const inserted = await pool.query(
      `INSERT INTO transactions (user_id, category_id, debit_account_id, debit, credit, date)
       VALUES ($1, $2, $3, 500, 500, '2026-03-08') RETURNING id`,
      [cId, bCat, acc]
    );
    const id = inserted.rows[0].id as number;
    expect((await remove(tokenA, bId)).status).toBe(200);

    const row = await pool.query(
      `SELECT t.user_id, c.user_id AS cat_owner, c.name, c.parent_id FROM transactions t
         JOIN categories c ON c.id = t.category_id WHERE t.id = $1`,
      [id]
    );
    expect(row.rows[0]).toEqual({ user_id: cId, cat_owner: cId, name: 'Bob tag', parent_id: 2 });

    const edited = await request(app)
      .put(`/api/transactions/${id}`)
      .set('Authorization', `Bearer ${tokenC}`)
      .send({ description: 'renamed' });
    expect(edited.status).toBe(200);
  });

  it('setting the co-owned creator to co-owner is a no-op', async () => {
    await grant(acc, bId, 3);
    const res = await setLevel(tokenB, aId, 3);
    expect(res.status).toBe(200);
    expect(await ownerOf()).toBe(aId);
    expect(res.body.data).toEqual([
      { user_id: aId, name: 'Alice', email: aEmail, level: 3, is_creator: true },
      { user_id: bId, name: 'Bob', email: bEmail, level: 3, is_creator: false },
    ]);
  });
});
