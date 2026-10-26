import request from 'supertest';
import { createTestApp } from './testApp';
import {
  MAX_FAILURES,
  WINDOW_MS,
  isBlocked,
  recordFailure,
  resetLoginLimiter,
} from '../services/loginLimiter';

const app = createTestApp();
const password = 'password123';

async function registerUser(prefix: string): Promise<string> {
  const email = `${prefix}${Date.now()}${Math.random().toString(36).slice(2, 8)}@example.com`;
  await request(app).post('/api/auth/register').send({ email, password });
  return email;
}

function login(email: string, pw: string) {
  return request(app).post('/api/auth/login').send({ email, password: pw });
}

async function failTimes(n: number, email: string | ((i: number) => string)) {
  for (let i = 0; i < n; i++) {
    const res = await login(typeof email === 'string' ? email : email(i), 'wrong-password');
    expect(res.status).toBe(401);
  }
}

describe('login throttling', () => {
  beforeEach(() => {
    resetLoginLimiter();
  });

  it('blocks the 11th attempt after 10 failures, even with the right password', async () => {
    const email = await registerUser('limit');
    await failTimes(MAX_FAILURES, email);

    const res = await login(email, password);
    expect(res.status).toBe(429);
    expect(res.body.data).toBeNull();
    expect(res.body.error).toBe('Too many failed login attempts, try again later');
  });

  it('counts the email case-insensitively', async () => {
    const email = await registerUser('upper');
    const mixed = email.charAt(0).toUpperCase() + email.slice(1);
    await failTimes(MAX_FAILURES, (i) => (i % 2 ? email : mixed));

    expect((await login(mixed, password)).status).toBe(429);
    expect((await login(email, password)).status).toBe(429);
  });

  it('does not block another email from the same address', async () => {
    const a = await registerUser('a');
    const b = await registerUser('b');
    await failTimes(MAX_FAILURES, a);

    expect((await login(b, password)).status).toBe(200);
  });

  it('a successful login clears the count', async () => {
    const email = await registerUser('clear');
    await failTimes(MAX_FAILURES - 1, email);
    expect((await login(email, password)).status).toBe(200);
    await failTimes(MAX_FAILURES - 1, email);

    expect((await login(email, password)).status).toBe(200);
  });

  it('the window expires', () => {
    for (let i = 0; i < MAX_FAILURES; i++) recordFailure('k', 0);

    expect(isBlocked('k', 1)).toBe(true);
    expect(isBlocked('k', WINDOW_MS + 1)).toBe(false);
  });
});
