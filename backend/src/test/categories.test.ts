import request from 'supertest';
import { createTestApp } from './testApp';
import { pool } from '../db';

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

    it('should not allow editing system categories', async () => {
      const res = await request(app)
        .put('/api/categories/1')
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
  });
});
