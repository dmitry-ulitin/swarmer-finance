import request from 'supertest';
import { createTestApp } from './testApp';
import { pool } from '../db';
import { findOrCreateCategoryPath } from '../db/queries/categories';

const app = createTestApp();

describe('Categories API', () => {
  let token: string;
  let testUserId: number;

  beforeAll(async () => {
    const email = `cat${Date.now()}@example.com`;
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email, password: 'password123' });
    token = res.body.data.accessToken;
    
    const userResult = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    testUserId = userResult.rows[0].id;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM transactions WHERE user_id = $1', [testUserId]);
    await pool.query('DELETE FROM categories WHERE user_id = $1', [testUserId]);
    await pool.query('DELETE FROM users WHERE id = $1', [testUserId]);
  });

  describe('GET /api/categories', () => {
    it('should return category tree with system roots', async () => {
      const res = await request(app)
        .get('/api/categories')
        .set({ Authorization: `Bearer ${token}` });

      expect(res.status).toBe(200);
      expect(res.body.data).toBeInstanceOf(Array);
      expect(res.body.data.length).toBeGreaterThan(0);
      
      const income = res.body.data.find((c: any) => c.id === 1);
      expect(income).toBeDefined();
      expect(income.name).toBe('Income');
      expect(income).toHaveProperty('children');
    });

    it('should nest Uncategorized under Income and Expenses, not as a top-level root', async () => {
      const res = await request(app)
        .get('/api/categories')
        .set({ Authorization: `Bearer ${token}` });

      expect(res.status).toBe(200);
      expect(res.body.data.map((c: any) => c.id).sort()).toEqual([1, 2]);

      const income = res.body.data.find((c: any) => c.id === 1);
      const expenses = res.body.data.find((c: any) => c.id === 2);
      expect(income.children.some((c: any) => c.id === 3 && c.name === 'Uncategorized')).toBe(true);
      expect(expenses.children.some((c: any) => c.id === 4 && c.name === 'Uncategorized')).toBe(true);
    });

    it('seeds Network fees under Expenses', async () => {
      const res = await request(app)
        .get('/api/categories')
        .set({ Authorization: `Bearer ${token}` });

      const expenses = res.body.data.find((c: any) => c.id === 2);
      expect(expenses.children.some((c: any) => c.id === 5 && c.name === 'Network fees')).toBe(true);
    });

    it('should require authentication', async () => {
      const res = await request(app)
        .get('/api/categories');

      expect(res.status).toBe(401);
    });
  });

  describe('POST /api/categories', () => {
    it('should create a new user category', async () => {
      const res = await request(app)
        .post('/api/categories')
        .set({ Authorization: `Bearer ${token}` })
        .send({
          name: 'Test Category',
          parentId: 1,
          color: '#ff0000',
          icon: 'test'
        });

      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('Test Category');
      expect(res.body.data.parent_id).toBe(1);
      expect(res.body.error).toBeNull();
    });

    it('should not allow creating category under non-leaf parent', async () => {
      const res = await request(app)
        .post('/api/categories')
        .set({ Authorization: `Bearer ${token}` })
        .send({
          name: 'Sub Category',
          parentId: 1
        });

      expect(res.status).toBe(200);
    });

    it('should return error for invalid parent', async () => {
      const res = await request(app)
        .post('/api/categories')
        .set({ Authorization: `Bearer ${token}` })
        .send({
          name: 'Test Category',
          parentId: 99999
        });

      expect(res.status).toBe(404);
    });
  });

  describe('findOrCreateCategoryPath', () => {
    it('rejects an empty path instead of dereferencing path[0]', async () => {
      // getCategoryPath returns [] for an id that no longer exists, so this
      // is reachable when a category is deleted mid-request. It must not
      // surface as a TypeError on path[0].id.
      await expect(findOrCreateCategoryPath(testUserId, [])).rejects.toThrow(
        /path is empty/
      );
    });
  });

  describe('PUT /api/categories/:id', () => {
    let categoryId: number;

    beforeEach(async () => {
      const unique = `PUT-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const res = await request(app)
        .post('/api/categories')
        .set({ Authorization: `Bearer ${token}` })
        .send({ name: unique, parentId: 1 });
      categoryId = res.body.data.id;
    });

    it('should update user category', async () => {
      const res = await request(app)
        .put(`/api/categories/${categoryId}`)
        .set({ Authorization: `Bearer ${token}` })
        .send({ name: 'Updated Category', color: '#00ff00' });

      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('Updated Category');
    });

    it('keeps the existing name when the update omits it', async () => {
      const before = await request(app)
        .put(`/api/categories/${categoryId}`)
        .set({ Authorization: `Bearer ${token}` })
        .send({ name: 'Keep Me' });
      expect(before.status).toBe(200);

      const res = await request(app)
        .put(`/api/categories/${categoryId}`)
        .set({ Authorization: `Bearer ${token}` })
        .send({ color: '#abcdef' });

      // name is optional in the schema, so omitting it must leave the stored
      // name alone rather than writing NULL into a NOT NULL column.
      expect(res.status).toBe(200);
      expect(res.body.data.color).toBe('#abcdef');
      expect(res.body.data.name).toBe('Keep Me');
    });

    describe('moving to another parent', () => {
      const create = async (name: string, parentId: number) => {
        const res = await request(app)
          .post('/api/categories')
          .set({ Authorization: `Bearer ${token}` })
          .send({ name, parentId });
        expect(res.status).toBe(200);
        return res.body.data;
      };
      const move = (id: number, parentId: number) =>
        request(app)
          .put(`/api/categories/${id}`)
          .set({ Authorization: `Bearer ${token}` })
          .send({ parentId });
      const suffix = () => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      it('moves the category with its children', async () => {
        const target = await create(`Target-${suffix()}`, 1);
        const child = await create('Child', categoryId);

        const res = await move(categoryId, target.id);
        expect(res.status).toBe(200);
        expect(res.body.data.parent_id).toBe(target.id);
        expect(res.body.data.fullName).toBe(`${target.name} / ${res.body.data.name}`);

        const moved = await pool.query('SELECT parent_id FROM categories WHERE id = $1', [child.id]);
        expect(moved.rows[0].parent_id).toBe(categoryId);
        const tree = await request(app).get('/api/categories').set({ Authorization: `Bearer ${token}` });
        const income = tree.body.data.find((c: { id: number }) => c.id === 1);
        const targetNode = income.children.find((c: { id: number }) => c.id === target.id);
        expect(targetNode.children[0].children[0].fullName).toBe(`${target.name} / ${res.body.data.name} / Child`);
      });

      it('refuses to move a category under itself or its descendant', async () => {
        const child = await create('Child', categoryId);

        const self = await move(categoryId, categoryId);
        expect(self.status).toBe(400);
        const below = await move(categoryId, child.id);
        expect(below.status).toBe(400);
        expect(below.body.error).toMatch(/under itself or its descendant/);
      });

      it('refuses to move a category to another root', async () => {
        const res = await move(categoryId, 2);
        expect(res.status).toBe(400);
        expect(res.body.error).toMatch(/another root/);
      });

      it('returns 404 for a missing parent', async () => {
        const res = await move(categoryId, 99999);
        expect(res.status).toBe(404);
      });

      it('rejects a move onto a sibling with the same name', async () => {
        const target = await create(`Target-${suffix()}`, 1);
        const current = await pool.query('SELECT name FROM categories WHERE id = $1', [categoryId]);
        await create(current.rows[0].name, target.id);

        const res = await move(categoryId, target.id);
        expect(res.status).toBe(409);
        expect(res.body.error).toContain(`"${current.rows[0].name}"`);
      });
    });

    it('should not allow editing system categories', async () => {
      const res = await request(app)
        .put('/api/categories/1')
        .set({ Authorization: `Bearer ${token}` })
        .send({ name: 'Hacked' });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('Cannot edit system categories');
    });

    it('should not allow editing the Uncategorized category', async () => {
      const res = await request(app)
        .put('/api/categories/4')
        .set({ Authorization: `Bearer ${token}` })
        .send({ name: 'Hacked' });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('Cannot edit system categories');
    });

    it('should not allow editing the Network fees category', async () => {
      const res = await request(app)
        .put('/api/categories/5')
        .set({ Authorization: `Bearer ${token}` })
        .send({ name: 'Hacked' });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('Cannot edit system categories');
    });
  });

  describe('Sibling uniqueness (uq_categories_sibling index)', () => {
    it('should reject creating a second sibling with the same name', async () => {
      const first = await request(app)
        .post('/api/categories')
        .set({ Authorization: `Bearer ${token}` })
        .send({ name: 'Dup-Test', parentId: 1 });
      expect(first.status).toBe(200);

      const duplicate = await request(app)
        .post('/api/categories')
        .set({ Authorization: `Bearer ${token}` })
        .send({ name: 'Dup-Test', parentId: 1 });
      expect(duplicate.status).toBe(409);
      expect(duplicate.body.error).toMatch(/sibling category named/);

      // cleanup
      await pool.query('DELETE FROM categories WHERE user_id = $1 AND name = $2', [testUserId, 'Dup-Test']);
    });

    it('should reject renaming a category into a sibling name', async () => {
      const a = await request(app)
        .post('/api/categories')
        .set({ Authorization: `Bearer ${token}` })
        .send({ name: 'Rename-A', parentId: 1 });
      const b = await request(app)
        .post('/api/categories')
        .set({ Authorization: `Bearer ${token}` })
        .send({ name: 'Rename-B', parentId: 1 });
      expect(a.status).toBe(200);
      expect(b.status).toBe(200);

      const conflict = await request(app)
        .put(`/api/categories/${b.body.data.id}`)
        .set({ Authorization: `Bearer ${token}` })
        .send({ name: 'Rename-A' });
      expect(conflict.status).toBe(409);
      expect(conflict.body.error).toMatch(/sibling category named/);

      // cleanup
      await pool.query(
        'DELETE FROM categories WHERE user_id = $1 AND name IN ($2, $3)',
        [testUserId, 'Rename-A', 'Rename-B']
      );
    });

    it('should allow the same name under different parents', async () => {
      // Get a child category under root Income (id=1) so we have a second parent.
      const parentRes = await request(app)
        .post('/api/categories')
        .set({ Authorization: `Bearer ${token}` })
        .send({ name: 'SameName-Parent', parentId: 1 });
      expect(parentRes.status).toBe(200);
      const parentId = parentRes.body.data.id;

      const child = await request(app)
        .post('/api/categories')
        .set({ Authorization: `Bearer ${token}` })
        .send({ name: 'SameName-Child', parentId });
      expect(child.status).toBe(200);

      // Different parent (root Income) — same name is allowed.
      const differentParent = await request(app)
        .post('/api/categories')
        .set({ Authorization: `Bearer ${token}` })
        .send({ name: 'SameName-Child', parentId: 1 });
      expect(differentParent.status).toBe(200);

      // cleanup
      await pool.query(
        'DELETE FROM categories WHERE user_id = $1 AND (name = $2 OR name = $3)',
        [testUserId, 'SameName-Parent', 'SameName-Child']
      );
    });
  });

  describe('DELETE /api/categories/:id', () => {
    let categoryId: number;

    beforeEach(async () => {
      const unique = `DEL-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const res = await request(app)
        .post('/api/categories')
        .set({ Authorization: `Bearer ${token}` })
        .send({ name: unique, parentId: 1 });
      categoryId = res.body.data.id;
    });

    it('should delete user category', async () => {
      const res = await request(app)
        .delete(`/api/categories/${categoryId}`)
        .set({ Authorization: `Bearer ${token}` });

      expect(res.status).toBe(200);
      expect(res.body.data.success).toBe(true);
    });

    it('should not allow deleting system categories', async () => {
      const res = await request(app)
        .delete('/api/categories/1')
        .set({ Authorization: `Bearer ${token}` });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('Cannot delete system categories');
    });

    it('should not allow deleting the Uncategorized category', async () => {
      const res = await request(app)
        .delete('/api/categories/3')
        .set({ Authorization: `Bearer ${token}` });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('Cannot delete system categories');
    });

    it('should not allow deleting the Network fees category', async () => {
      const res = await request(app)
        .delete('/api/categories/5')
        .set({ Authorization: `Bearer ${token}` });

      expect(res.status).toBe(403);
      expect(res.body.error).toContain('Cannot delete system categories');
    });
  });

  describe('deleting a category in use', () => {
    const auth = () => ({ Authorization: `Bearer ${token}` });
    let accountId: number;
    let parentId: number;
    let childId: number;

    const create = async (name: string, parent: number): Promise<number> => {
      const res = await request(app).post('/api/categories').set(auth()).send({ name, parentId: parent });
      return res.body.data.id;
    };
    const addExpense = async (categoryId: number): Promise<number> => {
      const res = await pool.query(
        `INSERT INTO transactions (user_id, category_id, debit_account_id, debit, credit, date)
         VALUES ($1, $2, $3, 100, 100, '2026-01-01') RETURNING id`,
        [testUserId, categoryId, accountId]
      );
      return res.rows[0].id;
    };
    const categoryOf = async (transactionId: number): Promise<number> =>
      (await pool.query('SELECT category_id FROM transactions WHERE id = $1', [transactionId])).rows[0].category_id;
    const parentOf = async (categoryId: number): Promise<number | undefined> =>
      (await pool.query('SELECT parent_id FROM categories WHERE id = $1', [categoryId])).rows[0]?.parent_id;

    beforeAll(async () => {
      const res = await pool.query(
        `INSERT INTO accounts (user_id, name, currency, scale, start_balance) VALUES ($1, 'Del', 'USD', 2, 0) RETURNING id`,
        [testUserId]
      );
      accountId = res.rows[0].id;
    });

    afterAll(async () => {
      await pool.query('DELETE FROM transactions WHERE user_id = $1', [testUserId]);
      await pool.query('DELETE FROM accounts WHERE id = $1', [accountId]);
    });

    beforeEach(async () => {
      const unique = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      parentId = await create(`Bills-${unique}`, 2);
      childId = await create('Subscriptions', parentId);
    });

    it('moves transactions and subcategories to a user parent', async () => {
      const tx = await addExpense(childId);
      const grandchild = await create('Streaming', childId);

      const preview = await request(app).get(`/api/categories/${childId}/delete-preview`).set(auth());
      expect(preview.status).toBe(200);
      expect(preview.body.data).toEqual({
        transactions: 1,
        subcategories: 1,
        transactionsTo: expect.stringMatching(/^Bills-/),
        subcategoriesTo: expect.stringMatching(/^Bills-/),
        conflicts: [],
      });

      const res = await request(app).delete(`/api/categories/${childId}`).set(auth());
      expect(res.status).toBe(200);
      expect(await categoryOf(tx)).toBe(parentId);
      expect(await parentOf(grandchild)).toBe(parentId);
      expect(await parentOf(childId)).toBeUndefined();
    });

    it('moves transactions to Uncategorized and subcategories to the root under a system parent', async () => {
      const tx = await addExpense(parentId);

      const preview = await request(app).get(`/api/categories/${parentId}/delete-preview`).set(auth());
      expect(preview.body.data).toMatchObject({
        transactions: 1,
        subcategories: 1,
        transactionsTo: 'Uncategorized',
        subcategoriesTo: 'Expenses',
      });

      const res = await request(app).delete(`/api/categories/${parentId}`).set(auth());
      expect(res.status).toBe(200);
      expect(await categoryOf(tx)).toBe(4);
      expect(await parentOf(childId)).toBe(2);
    });

    it('refuses when a subcategory name is already taken under the new parent', async () => {
      await create('Streaming', childId);
      await create('Streaming', parentId);
      const tx = await addExpense(childId);

      const preview = await request(app).get(`/api/categories/${childId}/delete-preview`).set(auth());
      expect(preview.body.data.conflicts).toEqual(['Streaming']);

      const res = await request(app).delete(`/api/categories/${childId}`).set(auth());
      expect(res.status).toBe(409);
      expect(res.body.error).toContain('Rename "Streaming" first');
      expect(await categoryOf(tx)).toBe(childId);
      expect(await parentOf(childId)).toBe(parentId);
    });

    it('does not preview or delete another user\'s category', async () => {
      const email = `catother${Date.now()}@example.com`;
      const other = await request(app).post('/api/auth/register').send({ email, password: 'password123' });
      const otherAuth = { Authorization: `Bearer ${other.body.data.accessToken}` };
      try {
        const preview = await request(app).get(`/api/categories/${childId}/delete-preview`).set(otherAuth);
        expect(preview.status).toBe(404);
        const res = await request(app).delete(`/api/categories/${childId}`).set(otherAuth);
        expect(res.status).toBe(404);
      } finally {
        await pool.query('DELETE FROM users WHERE email = $1', [email]);
      }
    });

    it('does not preview system categories', async () => {
      const res = await request(app).get('/api/categories/4/delete-preview').set(auth());
      expect(res.status).toBe(403);
    });
  });
});
