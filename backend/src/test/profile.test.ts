import request from 'supertest';
import { createTestApp } from './testApp';

const app = createTestApp();

describe('PUT /api/profile', () => {
  let email: string;
  let token: string;
  let refreshToken: string;

  beforeEach(async () => {
    email = `profile${Date.now()}@example.com`;
    const res = await request(app).post('/api/auth/register').send({ email, password: 'password123', name: 'Old' });
    token = res.body.data.accessToken;
    refreshToken = res.body.data.refreshToken;
  });

  const update = (body: object) =>
    request(app).put('/api/profile').set('Authorization', `Bearer ${token}`).send(body);

  it('updates name and currency and derives the currency scale', async () => {
    const res = await update({ name: '  New Name ', currency: 'JPY' });

    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({
      id: expect.any(Number), email, name: 'New Name', currency: 'JPY', currency_scale: 0,
    });

    // Persisted: the next refresh returns the updated user.
    const refreshed = await request(app).post('/api/auth/refresh').send({ refreshToken });
    expect(refreshed.body.data.user).toMatchObject({ name: 'New Name', currency: 'JPY', currency_scale: 0 });
  });

  it('reports the category summary in the new currency', async () => {
    await update({ name: 'Old', currency: 'BTC' });

    const summary = await request(app).get('/api/transactions/summary').set('Authorization', `Bearer ${token}`);
    expect(summary.body.data).toMatchObject({ currency: 'BTC', scale: 8 });
  });

  it('refuses an empty name', async () => {
    const res = await update({ name: '   ', currency: 'EUR' });
    expect(res.status).toBe(400);
  });

  it('refuses a malformed currency', async () => {
    const res = await update({ name: 'Old', currency: 'eur' });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('Currency');
  });

  it('refuses unknown fields', async () => {
    const res = await update({ name: 'Old', currency: 'EUR', email: 'other@example.com' });
    expect(res.status).toBe(400);
  });

  it('requires a token', async () => {
    const res = await request(app).put('/api/profile').send({ name: 'X', currency: 'EUR' });
    expect(res.status).toBe(401);
  });
});
