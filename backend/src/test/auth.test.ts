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

    it('treats emails case-insensitively: stores lowercase, logs in and refuses duplicates in any case', async () => {
      const email = `Mixed${Date.now()}@Example.com`;
      const reg = await request(app).post('/api/auth/register').send({ email, password: 'password123' });
      expect(reg.status).toBe(200);
      expect(reg.body.data.user.email).toBe(email.toLowerCase());

      const login = await request(app).post('/api/auth/login').send({ email: email.toUpperCase(), password: 'password123' });
      expect(login.status).toBe(200);

      const dup = await request(app).post('/api/auth/register').send({ email: email.toLowerCase(), password: 'password123' });
      expect(dup.status).toBe(400);
      expect(dup.body.error).toBe('Email already registered');
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

  describe('POST /api/auth/password', () => {
    let email: string;
    let token: string;

    beforeEach(async () => {
      email = `pwd${Date.now()}@example.com`;
      const res = await request(app).post('/api/auth/register').send({ email, password: 'password123' });
      token = res.body.data.accessToken;
    });

    const change = (body: object) =>
      request(app).post('/api/auth/password').set('Authorization', `Bearer ${token}`).send(body);

    it('changes the password: the new one logs in, the old one no longer does', async () => {
      const res = await change({ currentPassword: 'password123', newPassword: 'n3w-strong-pass' });
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ success: true });

      const oldLogin = await request(app).post('/api/auth/login').send({ email, password: 'password123' });
      expect(oldLogin.status).toBe(401);
      const newLogin = await request(app).post('/api/auth/login').send({ email, password: 'n3w-strong-pass' });
      expect(newLogin.status).toBe(200);
    });

    it('refuses a wrong current password with 400 and keeps the old one', async () => {
      const res = await change({ currentPassword: 'wrongpassword', newPassword: 'n3w-strong-pass' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('Current password is incorrect');

      const login = await request(app).post('/api/auth/login').send({ email, password: 'password123' });
      expect(login.status).toBe(200);
    });

    it('refuses a new password shorter than 8 characters', async () => {
      const res = await change({ currentPassword: 'password123', newPassword: 'short1' });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('newPassword');
    });

    it('refuses a new password equal to the current one', async () => {
      const res = await change({ currentPassword: 'password123', newPassword: 'password123' });
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('New password must differ from the current one');
    });

    it('requires a token', async () => {
      const res = await request(app)
        .post('/api/auth/password')
        .send({ currentPassword: 'password123', newPassword: 'n3w-strong-pass' });
      expect(res.status).toBe(401);
    });
  });

  describe('registration switch', () => {
    let saved: string | undefined;

    beforeEach(() => {
      saved = process.env.REGISTRATION_ENABLED;
    });

    afterEach(() => {
      if (saved === undefined) delete process.env.REGISTRATION_ENABLED;
      else process.env.REGISTRATION_ENABLED = saved;
    });

    it('refuses registration when REGISTRATION_ENABLED=false', async () => {
      process.env.REGISTRATION_ENABLED = 'false';
      const email = `closed${Date.now()}@example.com`;

      const res = await request(app).post('/api/auth/register').send({ email, password: 'password123' });
      expect(res.status).toBe(403);
      expect(res.body.data).toBeNull();
      expect(res.body.error).toBe('Registration is closed');

      const login = await request(app).post('/api/auth/login').send({ email, password: 'password123' });
      expect(login.status).toBe(401);
    });

    it('keeps registration open when REGISTRATION_ENABLED is unset or "true"', async () => {
      delete process.env.REGISTRATION_ENABLED;
      const unset = await request(app)
        .post('/api/auth/register')
        .send({ email: `open${Date.now()}@example.com`, password: 'password123' });
      expect(unset.status).toBe(200);

      process.env.REGISTRATION_ENABLED = 'true';
      const on = await request(app)
        .post('/api/auth/register')
        .send({ email: `open2${Date.now()}@example.com`, password: 'password123' });
      expect(on.status).toBe(200);
    });

    it('still allows login when registration is closed', async () => {
      const email = `existing${Date.now()}@example.com`;
      await request(app).post('/api/auth/register').send({ email, password: 'password123' });

      process.env.REGISTRATION_ENABLED = 'false';
      const res = await request(app).post('/api/auth/login').send({ email, password: 'password123' });
      expect(res.status).toBe(200);
    });
  });
});
