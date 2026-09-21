import request from 'supertest';
import { createTestApp } from './testApp';
import { pool } from '../db';
import { LEVEL, AccessLevel } from '../services/access';

const app = createTestApp();

/**
 * Categories are per-user, but transactions are visible across shared
 * accounts — so a visible transaction can carry a category its viewer does
 * not own. These tests pin the two halves of the fix: the category tree
 * reaches everyone whose categories can appear in my transactions, and
 * saving a foreign category copies the path into the transaction owner's
 * own tree instead of storing someone else's id.
 */
describe('Shared categories', () => {
  let tokenA: string;
  let tokenB: string;
  let tokenC: string;
  let userAId: number;
  let userBId: number;
  let userCId: number;
  let accountA: number; // owned by A, shared with B
  let accountC: number; // owned by C, shared with A

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

  const makeCategory = async (userId: number, name: string, parentId: number) => {
    const res = await pool.query(
      `INSERT INTO categories (user_id, name, parent_id, color, icon)
       VALUES ($1, $2, $3, '#123456', 'tag') RETURNING id`,
      [userId, name, parentId]
    );
    return res.rows[0].id as number;
  };

  const findInTree = (nodes: any[], id: number): any => {
    for (const node of nodes) {
      if (node.id === id) return node;
      const found = node.children ? findInTree(node.children, id) : null;
      if (found) return found;
    }
    return null;
  };

  beforeAll(async () => {
    const stamp = Date.now();
    const a = await register(`shcat-a-${stamp}@example.com`);
    const b = await register(`shcat-b-${stamp}@example.com`);
    const c = await register(`shcat-c-${stamp}@example.com`);
    tokenA = a.token; userAId = a.id;
    tokenB = b.token; userBId = b.id;
    tokenC = c.token; userCId = c.id;

    accountA = await makeAccount(userAId, 'A account');
    accountC = await makeAccount(userCId, 'C account');

    // A shares their account with B (B can write on A's account).
    await grant(accountA, userBId, LEVEL.WRITE);
    // C shares their account with A (A can see C's transactions).
    await grant(accountC, userAId, LEVEL.WRITE);
  });

  afterAll(async () => {
    const ids = [userAId, userBId, userCId];
    await pool.query(
      'DELETE FROM transactions WHERE debit_account_id = ANY($1::int[]) OR credit_account_id = ANY($1::int[])',
      [[accountA, accountC]]
    );
    await pool.query('DELETE FROM account_shares WHERE user_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM accounts WHERE user_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM categories WHERE user_id = ANY($1::int[])', [ids]);
    await pool.query('DELETE FROM users WHERE id = ANY($1::int[])', [ids]);
  });

  describe('GET /api/categories scope', () => {
    it("includes categories of users who own accounts shared with me", async () => {
      const cCategory = await makeCategory(userCId, `C-owned-${Date.now()}`, 2);

      const res = await request(app)
        .get('/api/categories')
        .set({ Authorization: `Bearer ${tokenA}` });

      expect(res.status).toBe(200);
      expect(findInTree(res.body.data, cCategory)).not.toBeNull();
    });

    it("includes categories of users I shared my own account with", async () => {
      // B owns no account A can reach, but B can write on A's account, so
      // B's categories can appear in transactions A sees.
      const bCategory = await makeCategory(userBId, `B-owned-${Date.now()}`, 2);

      const res = await request(app)
        .get('/api/categories')
        .set({ Authorization: `Bearer ${tokenA}` });

      expect(res.status).toBe(200);
      expect(findInTree(res.body.data, bCategory)).not.toBeNull();
    });

    it('excludes categories of unrelated users', async () => {
      const stamp = Date.now();
      const stranger = await register(`shcat-x-${stamp}@example.com`);
      const strangerCategory = await makeCategory(stranger.id, `X-owned-${stamp}`, 2);

      const res = await request(app)
        .get('/api/categories')
        .set({ Authorization: `Bearer ${tokenA}` });

      expect(res.status).toBe(200);
      expect(findInTree(res.body.data, strangerCategory)).toBeNull();

      await pool.query('DELETE FROM categories WHERE user_id = $1', [stranger.id]);
      await pool.query('DELETE FROM users WHERE id = $1', [stranger.id]);
    });

    it('carries fullName and root_id on every node of the tree', async () => {
      const stamp = Date.now();
      const parentName = `TreeParent-${stamp}`;
      const childName = `TreeChild-${stamp}`;
      const parent = await makeCategory(userAId, parentName, 2);
      const child = await makeCategory(userAId, childName, parent);

      const res = await request(app)
        .get('/api/categories')
        .set({ Authorization: `Bearer ${tokenA}` });

      expect(res.status).toBe(200);

      // The system root's own path is empty — fullName is the path below it.
      const expenses = res.body.data.find((c: any) => c.id === 2);
      expect(expenses.root_id).toBe(2);
      expect(expenses.fullName).toBe('');

      const parentNode = findInTree(res.body.data, parent);
      expect(parentNode.fullName).toBe(parentName);
      expect(parentNode.root_id).toBe(2);

      const childNode = findInTree(res.body.data, child);
      expect(childNode.fullName).toBe(`${parentName} / ${childName}`);
      expect(childNode.root_id).toBe(2);
    });

    it('reports the same fullName on the tree and on a transaction', async () => {
      const stamp = Date.now();
      const parent = await makeCategory(userAId, `SameP-${stamp}`, 2);
      const child = await makeCategory(userAId, `SameC-${stamp}`, parent);

      const created = await request(app)
        .post('/api/transactions')
        .set({ Authorization: `Bearer ${tokenA}` })
        .send({
          debitAccountId: accountA,
          categoryId: child,
          debit: 11,
          credit: 11,
          date: '2024-04-01',
        });
      expect(created.status).toBe(200);

      const tree = await request(app)
        .get('/api/categories')
        .set({ Authorization: `Bearer ${tokenA}` });

      const fromTree = findInTree(tree.body.data, child);
      expect(created.body.data.category.fullName).toBe(fromTree.fullName);
      expect(created.body.data.category.root_id).toBe(fromTree.root_id);
    });

    it('collapses the same path from two users into one node, preferring mine', async () => {
      const name = `Dup-${Date.now()}`;
      // C's copy is created first, so it wins on id order — ownership must
      // outrank list order.
      const cDup = await makeCategory(userCId, name, 2);
      const aDup = await makeCategory(userAId, name, 2);

      const res = await request(app)
        .get('/api/categories')
        .set({ Authorization: `Bearer ${tokenA}` });

      const expenses = res.body.data.find((c: any) => c.id === 2);
      const matches = expenses.children.filter((c: any) => c.fullName === name);
      expect(matches).toHaveLength(1);
      expect(matches[0].id).toBe(aDup);
      expect(matches[0].user_id).toBe(userAId);
      expect(findInTree(res.body.data, cDup)).toBeNull();
    });

    it('keeps a path only a co-owner has, represented by their category', async () => {
      const name = `OnlyTheirs-${Date.now()}`;
      const cOnly = await makeCategory(userCId, name, 2);

      const res = await request(app)
        .get('/api/categories')
        .set({ Authorization: `Bearer ${tokenA}` });

      const node = findInTree(res.body.data, cOnly);
      expect(node).not.toBeNull();
      expect(node.user_id).toBe(userCId);
    });

    it('picks the first by id when nobody owning the path is me', async () => {
      const name = `TwoForeign-${Date.now()}`;
      const bDup = await makeCategory(userBId, name, 2);
      const cDup = await makeCategory(userCId, name, 2);

      const res = await request(app)
        .get('/api/categories')
        .set({ Authorization: `Bearer ${tokenA}` });

      const expenses = res.body.data.find((c: any) => c.id === 2);
      const matches = expenses.children.filter((c: any) => c.fullName === name);
      expect(matches).toHaveLength(1);
      expect(matches[0].id).toBe(Math.min(bDup, cDup));
    });

    it('nests children by path, merging under one parent node', async () => {
      const stamp = Date.now();
      const parentName = `MergeP-${stamp}`;
      const childName = `MergeC-${stamp}`;

      // Both users have the same two-level path, via different parent rows.
      const aParent = await makeCategory(userAId, parentName, 2);
      const aChild = await makeCategory(userAId, childName, aParent);
      const cParent = await makeCategory(userCId, parentName, 2);
      const cChild = await makeCategory(userCId, childName, cParent);

      const res = await request(app)
        .get('/api/categories')
        .set({ Authorization: `Bearer ${tokenA}` });

      const expenses = res.body.data.find((c: any) => c.id === 2);
      const parents = expenses.children.filter((c: any) => c.fullName === parentName);
      expect(parents).toHaveLength(1);
      expect(parents[0].id).toBe(aParent);

      const children = parents[0].children.filter(
        (c: any) => c.fullName === `${parentName} / ${childName}`
      );
      expect(children).toHaveLength(1);
      expect(children[0].id).toBe(aChild);
      expect(findInTree(res.body.data, cParent)).toBeNull();
      expect(findInTree(res.body.data, cChild)).toBeNull();
    });

    it("nests a co-owner's child under my parent when only they have the child", async () => {
      const stamp = Date.now();
      const parentName = `MixedP-${stamp}`;
      const childName = `MixedC-${stamp}`;

      const aParent = await makeCategory(userAId, parentName, 2);
      const cParent = await makeCategory(userCId, parentName, 2);
      const cChild = await makeCategory(userCId, childName, cParent);

      const res = await request(app)
        .get('/api/categories')
        .set({ Authorization: `Bearer ${tokenA}` });

      const expenses = res.body.data.find((c: any) => c.id === 2);
      const parent = expenses.children.find((c: any) => c.fullName === parentName);
      // My parent row won, and their child hangs off it by path even though
      // its parent_id points at their row.
      expect(parent.id).toBe(aParent);
      expect(parent.children.map((c: any) => c.id)).toContain(cChild);
    });

    it('keeps Income and Expenses separate when the paths are identical', async () => {
      const name = `BothRoots-${Date.now()}`;
      const income = await makeCategory(userAId, name, 1);
      const expense = await makeCategory(userAId, name, 2);

      const res = await request(app)
        .get('/api/categories')
        .set({ Authorization: `Bearer ${tokenA}` });

      expect(findInTree(res.body.data, income)).not.toBeNull();
      expect(findInTree(res.body.data, expense)).not.toBeNull();
    });

    it('marks each category with its owner so foreign ones are distinguishable', async () => {
      const res = await request(app)
        .get('/api/categories')
        .set({ Authorization: `Bearer ${tokenA}` });

      const expenses = res.body.data.find((c: any) => c.id === 2);
      expect(expenses.user_id).toBeNull();
      const foreign = expenses.children.find((c: any) => c.user_id === userCId);
      expect(foreign).toBeDefined();
      expect(foreign.owner_name).toBeDefined();
    });
  });

  describe('creating a category under a foreign parent', () => {
    it("copies the parent path into my tree and creates the child there", async () => {
      const stamp = Date.now();
      const parentName = `TheirParent-${stamp}`;
      const cParent = await makeCategory(userCId, parentName, 2);

      // The merged tree shows C's row for this path, so that is the id the
      // client sends as parentId.
      const created = await request(app)
        .post('/api/categories')
        .set({ Authorization: `Bearer ${tokenA}` })
        .send({ name: `MyChild-${stamp}`, parentId: cParent });

      expect(created.status).toBe(200);
      expect(created.body.data.user_id).toBe(userAId);
      expect(created.body.data.fullName).toBe(`${parentName} / MyChild-${stamp}`);

      // A copy of the parent now exists under A, and the child hangs off it.
      const myParent = await pool.query(
        'SELECT id FROM categories WHERE user_id = $1 AND name = $2',
        [userAId, parentName]
      );
      expect(myParent.rows).toHaveLength(1);
      expect(created.body.data.parent_id).toBe(myParent.rows[0].id);
      // C's row is untouched.
      const theirChildren = await pool.query(
        'SELECT id FROM categories WHERE parent_id = $1',
        [cParent]
      );
      expect(theirChildren.rows).toHaveLength(0);
    });

    it('reuses my existing category for that path instead of duplicating it', async () => {
      const stamp = Date.now();
      const parentName = `SharedParent-${stamp}`;
      const cParent = await makeCategory(userCId, parentName, 2);
      const aParent = await makeCategory(userAId, parentName, 2);

      const created = await request(app)
        .post('/api/categories')
        .set({ Authorization: `Bearer ${tokenA}` })
        .send({ name: `Child-${stamp}`, parentId: cParent });

      expect(created.status).toBe(200);
      expect(created.body.data.parent_id).toBe(aParent);

      const copies = await pool.query(
        'SELECT id FROM categories WHERE user_id = $1 AND name = $2',
        [userAId, parentName]
      );
      expect(copies.rows).toHaveLength(1);
    });

    it('still creates directly under a system root', async () => {
      const created = await request(app)
        .post('/api/categories')
        .set({ Authorization: `Bearer ${tokenA}` })
        .send({ name: `TopLevel-${Date.now()}`, parentId: 2 });

      expect(created.status).toBe(200);
      expect(created.body.data.parent_id).toBe(2);
      expect(created.body.data.user_id).toBe(userAId);
    });

    it("refuses a parent belonging to an unrelated user", async () => {
      const stamp = Date.now();
      const stranger = await register(`shcat-z-${stamp}@example.com`);
      const strangerParent = await makeCategory(stranger.id, `Z-${stamp}`, 2);

      const created = await request(app)
        .post('/api/categories')
        .set({ Authorization: `Bearer ${tokenA}` })
        .send({ name: `Nope-${stamp}`, parentId: strangerParent });

      expect(created.status).toBe(403);

      await pool.query('DELETE FROM categories WHERE user_id = $1', [stranger.id]);
      await pool.query('DELETE FROM users WHERE id = $1', [stranger.id]);
    });

    it('rejects a duplicate sibling after the parent is resolved', async () => {
      const stamp = Date.now();
      const parentName = `DupParent-${stamp}`;
      const childName = `DupChild-${stamp}`;
      const cParent = await makeCategory(userCId, parentName, 2);
      const aParent = await makeCategory(userAId, parentName, 2);
      await makeCategory(userAId, childName, aParent);

      const created = await request(app)
        .post('/api/categories')
        .set({ Authorization: `Bearer ${tokenA}` })
        .send({ name: childName, parentId: cParent });

      expect(created.status).toBe(409);
    });
  });

  describe('transaction DTO category shape', () => {
    it('carries every category field except children, plus fullName and root_id', async () => {
      const parent = await makeCategory(userAId, `Parent-${Date.now()}`, 2);
      const child = await makeCategory(userAId, `Child-${Date.now()}`, parent);

      const created = await request(app)
        .post('/api/transactions')
        .set({ Authorization: `Bearer ${tokenA}` })
        .send({
          debitAccountId: accountA,
          categoryId: child,
          debit: 10,
          credit: 10,
          date: '2024-03-01',
        });

      expect(created.status).toBe(200);
      const category = created.body.data.category;
      expect(category.id).toBe(child);
      expect(category.user_id).toBe(userAId);
      expect(category.parent_id).toBe(parent);
      expect(category.color).toBe('#123456');
      expect(category.icon).toBe('tag');
      expect(category.created_at).toBeDefined();
      expect(category.root_id).toBe(2);
      expect(category).not.toHaveProperty('children');

      const parentRow = await pool.query('SELECT name FROM categories WHERE id = $1', [parent]);
      const childRow = await pool.query('SELECT name FROM categories WHERE id = $1', [child]);
      expect(category.fullName).toBe(`${parentRow.rows[0].name} / ${childRow.rows[0].name}`);
    });

    it('gives a first-level category a fullName without the system root', async () => {
      const flat = await makeCategory(userAId, `Flat-${Date.now()}`, 2);

      const created = await request(app)
        .post('/api/transactions')
        .set({ Authorization: `Bearer ${tokenA}` })
        .send({
          debitAccountId: accountA,
          categoryId: flat,
          debit: 5,
          credit: 5,
          date: '2024-03-02',
        });

      expect(created.status).toBe(200);
      const row = await pool.query('SELECT name FROM categories WHERE id = $1', [flat]);
      expect(created.body.data.category.fullName).toBe(row.rows[0].name);
    });
  });

  describe('copy-on-save of a foreign category', () => {
    it("copies a foreign category into the transaction owner's tree on create", async () => {
      const name = `CFood-${Date.now()}`;
      const cCategory = await makeCategory(userCId, name, 2);

      // A creates a transaction on C's shared account, picking C's category.
      const created = await request(app)
        .post('/api/transactions')
        .set({ Authorization: `Bearer ${tokenA}` })
        .send({
          debitAccountId: accountC,
          categoryId: cCategory,
          debit: 20,
          credit: 20,
          date: '2024-03-03',
        });

      expect(created.status).toBe(200);
      // A authored it, so the copy lands in A's tree, not C's id.
      expect(created.body.data.category.id).not.toBe(cCategory);
      expect(created.body.data.category.user_id).toBe(userAId);
      expect(created.body.data.category.name).toBe(name);
      expect(created.body.data.category.parent_id).toBe(2);
    });

    it('reuses an existing category with the same path instead of duplicating', async () => {
      const name = `Shared-${Date.now()}`;
      const cCategory = await makeCategory(userCId, name, 2);
      const aCategory = await makeCategory(userAId, name, 2);

      const created = await request(app)
        .post('/api/transactions')
        .set({ Authorization: `Bearer ${tokenA}` })
        .send({
          debitAccountId: accountC,
          categoryId: cCategory,
          debit: 30,
          credit: 30,
          date: '2024-03-04',
        });

      expect(created.status).toBe(200);
      expect(created.body.data.category.id).toBe(aCategory);

      const copies = await pool.query(
        'SELECT id FROM categories WHERE user_id = $1 AND name = $2',
        [userAId, name]
      );
      expect(copies.rows).toHaveLength(1);
    });

    it('creates missing ancestors when copying a nested path', async () => {
      const stamp = Date.now();
      const parentName = `CParent-${stamp}`;
      const childName = `CChild-${stamp}`;
      const cParent = await makeCategory(userCId, parentName, 2);
      const cChild = await makeCategory(userCId, childName, cParent);

      const created = await request(app)
        .post('/api/transactions')
        .set({ Authorization: `Bearer ${tokenA}` })
        .send({
          debitAccountId: accountC,
          categoryId: cChild,
          debit: 40,
          credit: 40,
          date: '2024-03-05',
        });

      expect(created.status).toBe(200);
      expect(created.body.data.category.user_id).toBe(userAId);
      expect(created.body.data.category.name).toBe(childName);
      expect(created.body.data.category.fullName).toBe(`${parentName} / ${childName}`);

      const copiedParent = await pool.query(
        'SELECT id, parent_id FROM categories WHERE user_id = $1 AND name = $2',
        [userAId, parentName]
      );
      expect(copiedParent.rows).toHaveLength(1);
      expect(copiedParent.rows[0].parent_id).toBe(2);
      expect(created.body.data.category.parent_id).toBe(copiedParent.rows[0].id);
    });

    it("copies into the original author's tree when someone else edits their transaction", async () => {
      const stamp = Date.now();
      // B authors a transaction on A's shared account.
      const bCategory = await makeCategory(userBId, `BOwn-${stamp}`, 2);
      const created = await request(app)
        .post('/api/transactions')
        .set({ Authorization: `Bearer ${tokenB}` })
        .send({
          debitAccountId: accountA,
          categoryId: bCategory,
          debit: 50,
          credit: 50,
          date: '2024-03-06',
        });
      expect(created.status).toBe(200);
      const txId = created.body.data.id;

      // A edits it, choosing one of A's own categories.
      const aName = `AEdit-${stamp}`;
      const aCategory = await makeCategory(userAId, aName, 2);
      const updated = await request(app)
        .put(`/api/transactions/${txId}`)
        .set({ Authorization: `Bearer ${tokenA}` })
        .send({ categoryId: aCategory });

      expect(updated.status).toBe(200);
      // The transaction stays attributed to B, so the category does too:
      // A's pick is copied into B's tree rather than stored as A's id.
      expect(updated.body.data.user_id).toBe(userBId);
      expect(updated.body.data.category.user_id).toBe(userBId);
      expect(updated.body.data.category.name).toBe(aName);
      expect(updated.body.data.category.id).not.toBe(aCategory);
    });

    it("refuses a category the editor can see but the transaction owner cannot", async () => {
      const stamp = Date.now();
      // D is related to B but not to A: D shares an account with B only.
      const d = await register(`shcat-d-${stamp}@example.com`);
      const accountD = await makeAccount(d.id, 'D account');
      await grant(accountD, userBId, LEVEL.WRITE);
      const dName = `DOwn-${stamp}`;
      const dCategory = await makeCategory(d.id, dName, 2);

      // A authors a transaction on A's own account, so the transaction's
      // owner is A and the category would be written into A's tree.
      const created = await request(app)
        .post('/api/transactions')
        .set({ Authorization: `Bearer ${tokenA}` })
        .send({
          debitAccountId: accountA,
          debit: 80,
          credit: 80,
          date: '2024-03-09',
        });
      expect(created.status).toBe(200);
      expect(created.body.data.user_id).toBe(userAId);

      // B may write on A's account, and D's category is visible to B — but
      // the copy would land in A's tree, and A shares nothing with D.
      const updated = await request(app)
        .put(`/api/transactions/${created.body.data.id}`)
        .set({ Authorization: `Bearer ${tokenB}` })
        .send({ categoryId: dCategory });

      expect(updated.status).toBe(403);
      // The status alone would pass even if the row leaked; this is the
      // assertion that pins the bug.
      const leaked = await pool.query(
        'SELECT id FROM categories WHERE user_id = $1 AND name = $2',
        [userAId, dName]
      );
      expect(leaked.rows).toHaveLength(0);

      await pool.query('DELETE FROM account_shares WHERE account_id = $1', [accountD]);
      await pool.query('DELETE FROM accounts WHERE user_id = $1', [d.id]);
      await pool.query('DELETE FROM categories WHERE user_id = $1', [d.id]);
      await pool.query('DELETE FROM users WHERE id = $1', [d.id]);
    });

    it('leaves a system category untouched rather than copying it', async () => {
      const created = await request(app)
        .post('/api/transactions')
        .set({ Authorization: `Bearer ${tokenA}` })
        .send({
          debitAccountId: accountA,
          debit: 60,
          credit: 60,
          date: '2024-03-07',
        });

      expect(created.status).toBe(200);
      expect(created.body.data.category.id).toBe(4);
      expect(created.body.data.category.user_id).toBeNull();
    });

    it('rejects a category belonging to an unrelated user', async () => {
      const stamp = Date.now();
      const stranger = await register(`shcat-y-${stamp}@example.com`);
      const strangerCategory = await makeCategory(stranger.id, `Y-${stamp}`, 2);

      const created = await request(app)
        .post('/api/transactions')
        .set({ Authorization: `Bearer ${tokenA}` })
        .send({
          debitAccountId: accountA,
          categoryId: strangerCategory,
          debit: 70,
          credit: 70,
          date: '2024-03-08',
        });

      expect(created.status).toBe(403);

      await pool.query('DELETE FROM categories WHERE user_id = $1', [stranger.id]);
      await pool.query('DELETE FROM users WHERE id = $1', [stranger.id]);
    });
  });

  /**
   * The tree shows one node per path, but that node is backed by a row per
   * user and stands for its whole subtree. Filtering by a category therefore
   * has to match all three: the row itself, co-owners' rows at the same
   * path, and everything below it.
   */
  describe('filtering transactions by category', () => {
    const txIds: number[] = [];

    const spend = async (token: string, accountId: number, categoryId: number, amount: number) => {
      const res = await request(app)
        .post('/api/transactions')
        .set({ Authorization: `Bearer ${token}` })
        .send({ debitAccountId: accountId, categoryId, debit: amount, credit: amount, date: '2024-05-01' });
      expect(res.status).toBe(200);
      txIds.push(res.body.data.id);
      return res.body.data;
    };

    const filterBy = async (token: string, categoryId: number) => {
      const res = await request(app)
        .get(`/api/transactions?category=${categoryId}`)
        .set({ Authorization: `Bearer ${token}` });
      expect(res.status).toBe(200);
      return res.body.data as any[];
    };

    afterEach(async () => {
      if (txIds.length) {
        await pool.query('DELETE FROM transactions WHERE id = ANY($1::int[])', [txIds]);
        txIds.length = 0;
      }
    });

    it("includes a co-owner's row at the same path", async () => {
      const stamp = Date.now();
      const name = `FilterFood-${stamp}`;
      // A and B each end up with their own row for the same path: A picks
      // their own, B's pick is copied into B's tree on save.
      const aCategory = await makeCategory(userAId, name, 2);
      const aTx = await spend(tokenA, accountA, aCategory, 11);
      const bTx = await spend(tokenB, accountA, aCategory, 22);

      // Two distinct rows, one node.
      expect(bTx.category.id).not.toBe(aCategory);
      expect(bTx.category.user_id).toBe(userBId);

      const filtered = await filterBy(tokenA, aCategory);
      const ids = filtered.map(t => t.id);
      expect(ids).toContain(aTx.id);
      expect(ids).toContain(bTx.id);
    });

    it('includes descendants of the filtered category', async () => {
      const stamp = Date.now();
      const parentName = `FilterParent-${stamp}`;
      const parent = await makeCategory(userAId, parentName, 2);
      const child = await makeCategory(userAId, `FilterChild-${stamp}`, parent);
      const grandchild = await makeCategory(userAId, `FilterGrand-${stamp}`, child);

      const parentTx = await spend(tokenA, accountA, parent, 10);
      const childTx = await spend(tokenA, accountA, child, 20);
      const grandTx = await spend(tokenA, accountA, grandchild, 30);

      const ids = (await filterBy(tokenA, parent)).map(t => t.id);
      expect(ids).toContain(parentTx.id);
      expect(ids).toContain(childTx.id);
      expect(ids).toContain(grandTx.id);

      // Filtering the child excludes the parent but keeps the grandchild.
      const childIds = (await filterBy(tokenA, child)).map(t => t.id);
      expect(childIds).not.toContain(parentTx.id);
      expect(childIds).toContain(childTx.id);
      expect(childIds).toContain(grandTx.id);
    });

    it("includes a co-owner's descendant of the filtered path", async () => {
      const stamp = Date.now();
      const parentName = `CoParent-${stamp}`;
      const aParent = await makeCategory(userAId, parentName, 2);
      // B owns a child under the same path that A has no row for.
      const bParent = await makeCategory(userBId, parentName, 2);
      const bChild = await makeCategory(userBId, `CoChild-${stamp}`, bParent);
      const bTx = await spend(tokenB, accountA, bChild, 44);

      const ids = (await filterBy(tokenA, aParent)).map(t => t.id);
      expect(ids).toContain(bTx.id);
    });

    it('excludes a sibling whose name merely shares a prefix', async () => {
      const stamp = Date.now();
      const food = await makeCategory(userAId, `Food-${stamp}`, 2);
      const foodie = await makeCategory(userAId, `Food-${stamp}ie`, 2);
      const foodTx = await spend(tokenA, accountA, food, 10);
      const foodieTx = await spend(tokenA, accountA, foodie, 20);

      const ids = (await filterBy(tokenA, food)).map(t => t.id);
      expect(ids).toContain(foodTx.id);
      expect(ids).not.toContain(foodieTx.id);
    });

    it('does not match a name-alike path owned by an unrelated user', async () => {
      const stamp = Date.now();
      const shared = `Groceries-${stamp}`;
      const aCategory = await makeCategory(userAId, shared, 2);
      const aTx = await spend(tokenA, accountA, aCategory, 15);

      // A stranger with the very same path, on their own account.
      const stranger = await register(`shcat-f-${stamp}@example.com`);
      const strangerAccount = await makeAccount(stranger.id, 'F account');
      const strangerCategory = await makeCategory(stranger.id, shared, 2);
      const strangerTx = await request(app)
        .post('/api/transactions')
        .set({ Authorization: `Bearer ${stranger.token}` })
        .send({ debitAccountId: strangerAccount, categoryId: strangerCategory, debit: 99, credit: 99, date: '2024-05-01' });
      expect(strangerTx.status).toBe(200);

      const ids = (await filterBy(tokenA, aCategory)).map(t => t.id);
      expect(ids).toContain(aTx.id);
      expect(ids).not.toContain(strangerTx.body.data.id);

      await pool.query('DELETE FROM transactions WHERE id = $1', [strangerTx.body.data.id]);
      await pool.query('DELETE FROM accounts WHERE user_id = $1', [stranger.id]);
      await pool.query('DELETE FROM categories WHERE user_id = $1', [stranger.id]);
      await pool.query('DELETE FROM users WHERE id = $1', [stranger.id]);
    });

    it('returns nothing when the filtered category matches no row', async () => {
      const aCategory = await makeCategory(userAId, `Lonely-${Date.now()}`, 2);
      await spend(tokenA, accountA, aCategory, 12);

      // An id that exists for nobody: the expansion is empty, which must
      // mean "no match", never "no filter".
      const res = await request(app)
        .get('/api/transactions?category=99999999')
        .set({ Authorization: `Bearer ${tokenA}` });

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(0);
    });
  });

});
