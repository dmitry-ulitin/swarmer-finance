import request from 'supertest';
import * as fs from 'fs';
import * as path from 'path';
import { createTestApp } from './testApp';
import { pool } from '../db';

const app = createTestApp();
const fixtureB64 = (...p: string[]) =>
  fs.readFileSync(path.join(__dirname, 'fixtures', 'banks', ...p)).toString('base64');

describe('Import API', () => {
  let token: string;
  let userId: number;
  let accountId: number;

  beforeAll(async () => {
    const email = `api${Date.now()}@example.com`;
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email, password: 'password123' });
    token = res.body.data.accessToken;
    const u = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    userId = u.rows[0].id;
    const a = await pool.query(
      `INSERT INTO accounts (user_id, name, currency, start_balance)
       VALUES ($1, 'API Account', 'EUR', 0) RETURNING id`,
      [userId]
    );
    accountId = a.rows[0].id;
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

  it('requires authentication', async () => {
    const res = await request(app).post('/api/import/parse').send({});
    expect(res.status).toBe(401);
  });

  it('rejects a body with no content', async () => {
    const res = await request(app)
      .post('/api/import/parse')
      .set('Authorization', `Bearer ${token}`)
      .send({ accountId });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  it('parses a statement and returns the envelope', async () => {
    const res = await request(app)
      .post('/api/import/parse')
      .set('Authorization', `Bearer ${token}`)
      .send({ accountId, content: fixtureB64('lhv', 'statement.csv') });
    expect(res.status).toBe(200);
    expect(res.body.error).toBeNull();
    expect(res.body.data.format).toBe('lhv');
    expect(res.body.data.rows).toHaveLength(143);
    expect(res.body.data.summary.total).toBe(143);
  });

  it('reconciles the parsed rows', async () => {
    const parsed = await request(app)
      .post('/api/import/parse')
      .set('Authorization', `Bearer ${token}`)
      .send({ accountId, content: fixtureB64('lhv', 'statement.csv') });

    const res = await request(app)
      .post('/api/import/reconcile')
      .set('Authorization', `Bearer ${token}`)
      .send({ accountId, rows: parsed.body.data.rows });

    expect(res.status).toBe(200);
    expect(res.body.data.created).toBe(143);
  });

  it('surfaces a currency mismatch as 400', async () => {
    const usd = await pool.query(
      `INSERT INTO accounts (user_id, name, currency, start_balance)
       VALUES ($1, 'USD', 'USD', 0) RETURNING id`,
      [userId]
    );
    const res = await request(app)
      .post('/api/import/parse')
      .set('Authorization', `Bearer ${token}`)
      .send({ accountId: usd.rows[0].id, content: fixtureB64('lhv', 'statement.csv') });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('USD');
  });
});
