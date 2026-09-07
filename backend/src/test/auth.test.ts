import request from 'supertest';
import { createTestApp } from './testApp';
import { pool } from '../db';

const app = createTestApp();

describe('Auth API', () => {
  const uniqueEmail = `test${Date.now()}@example.com`;

  describe('POST /api/auth/register', () => {
    it('should register a new user', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ email: uniqueEmail, password: 'password123' });

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty('user');
      expect(res.body.data).toHaveProperty('accessToken');
      expect(res.body.data).toHaveProperty('refreshToken');
      expect(res.body.error).toBeNull();
    });

    it('should return error for duplicate email', async () => {
      await request(app)
        .post('/api/auth/register')
        .send({ email: uniqueEmail, password: 'password123' });

      const res = await request(app)
        .post('/api/auth/register')
        .send({ email: uniqueEmail, password: 'password123' });

      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Email already registered');
    });

    it('should return error for invalid email', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ email: 'invalid', password: 'password123' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('email');
    });

    it('should return error for short password', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ email: `test2${Date.now()}@example.com`, password: '123' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('password');
    });

    it('should return error for invalid currency format', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ email: `test7${Date.now()}@example.com`, password: 'password123', currency: 'usd' });

      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Currency');
    });

    it('should default currency_scale to 2 when not provided', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ email: `test3${Date.now()}@example.com`, password: 'password123' });

      expect(res.status).toBe(200);
      expect(res.body.data.user.currency_scale).toBe(2);
    });

    it('should ignore a client-supplied currencyScale and derive it from currency', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ email: `test4${Date.now()}@example.com`, password: 'password123', currencyScale: 8 });

      expect(res.status).toBe(200);
      expect(res.body.data.user.currency_scale).toBe(2);
    });

    it('should derive currency_scale of 0 for a zero-decimal currency', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ email: `test5${Date.now()}@example.com`, password: 'password123', currency: 'JPY' });

      expect(res.status).toBe(200);
      expect(res.body.data.user.currency_scale).toBe(0);
    });

    it('should derive currency_scale of 3 for a three-decimal currency', async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ email: `test6${Date.now()}@example.com`, password: 'password123', currency: 'BHD' });

      expect(res.status).toBe(200);
      expect(res.body.data.user.currency_scale).toBe(3);
    });
  });

  describe('POST /api/auth/login', () => {
    beforeAll(async () => {
      await request(app)
        .post('/api/auth/register')
        .send({ email: uniqueEmail, password: 'password123' });
    });

    it('should login with valid credentials', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: uniqueEmail, password: 'password123' });

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty('accessToken');
      expect(res.body.error).toBeNull();
    });

    it('should return error for invalid email', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: 'wrong@example.com', password: 'password123' });

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Invalid credentials');
    });

    it('should return error for invalid password', async () => {
      const res = await request(app)
        .post('/api/auth/login')
        .send({ email: uniqueEmail, password: 'wrongpassword' });

      expect(res.status).toBe(401);
      expect(res.body.error).toBe('Invalid credentials');
    });
  });

  describe('POST /api/auth/refresh', () => {
    let refreshToken: string;

    beforeAll(async () => {
      const res = await request(app)
        .post('/api/auth/register')
        .send({ email: `refresh${Date.now()}@example.com`, password: 'password123' });
      refreshToken = res.body.data.refreshToken;
    });

    it('should refresh access token', async () => {
      const res = await request(app)
        .post('/api/auth/refresh')
        .send({ refreshToken });

      expect(res.status).toBe(200);
      expect(res.body.data).toHaveProperty('accessToken');
    });

    it('should return error for invalid token', async () => {
      const res = await request(app)
        .post('/api/auth/refresh')
        .send({ refreshToken: 'invalid-token' });

      expect(res.status).toBe(401);
    });
  });
});
