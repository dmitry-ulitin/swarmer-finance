import request from 'supertest';
import { createTestApp } from './testApp';
import { pool } from '../db';
import { errorHandler } from '../middleware/error';

const app = createTestApp();

describe('Request validation', () => {
  let token: string;
  let userId: number;
  const auth = () => ({ Authorization: `Bearer ${token}` });

  beforeAll(async () => {
    const email = `validation${Date.now()}@example.com`;
    const res = await request(app).post('/api/auth/register').send({ email, password: 'password123' });
    token = res.body.data.accessToken;
    userId = res.body.data.user.id;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM categories WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  });

  it.each(['2026-02-31', '2026-1-01', 'yesterday', '2026-01-01T10:00'])(
    'rejects the transaction date %s with 400',
    async (date) => {
      const res = await request(app).post('/api/transactions').set(auth())
        .send({ creditAccountId: 1, debit: 1, credit: 1, date });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/date/);
    }
  );

  it('rejects an impossible filter date with 400', async () => {
    const res = await request(app).get('/api/transactions?from=2026-13-01').set(auth());
    expect(res.status).toBe(400);
  });

  it('rejects an impossible import row date with 400', async () => {
    const res = await request(app).post('/api/import/reconcile').set(auth())
      .send({ accountId: 1, rows: [{ date: '2026-02-30', amount: 1, hash: 'h' }] });
    expect(res.status).toBe(400);
  });

  it.each([
    ['put', '/api/transactions/abc'],
    ['delete', '/api/accounts/1.5'],
    ['delete', '/api/accounts/1/shares/x'],
    ['get', '/api/categories/99999999999/delete-preview'],
  ] as const)('rejects a non-integer id: %s %s', async (method, url) => {
    const res = await request(app)[method](url).set(auth()).send({});
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid id');
  });
});

describe('errorHandler', () => {
  it('does not describe an unexpected error to the client', () => {
    const json = jest.fn();
    const res = { status: jest.fn().mockReturnValue({ json }) };
    const origError = console.error;
    console.error = () => {};
    try {
      errorHandler(new Error('relation "secret" does not exist'), {} as never, res as never, () => {});
    } finally {
      console.error = origError;
    }
    expect(res.status).toHaveBeenCalledWith(500);
    expect(json).toHaveBeenCalledWith({ data: null, error: 'Internal server error' });
  });
});
