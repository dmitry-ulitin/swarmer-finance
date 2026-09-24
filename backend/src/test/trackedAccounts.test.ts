import request from 'supertest';
import { createTestApp } from './testApp';
import { pool } from '../db';

const app = createTestApp();
const WALLET = { type: 'crypto', settings: { address: 'bc1qtracked', blockchain: 'bitcoin' } };

describe('Tracked (blockchain-synced) accounts', () => {
  let token: string;
  let userId: number;
  const auth = () => ({ Authorization: `Bearer ${token}` });

  // Account DTOs convert balances through the rates API; keep it offline.
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

  beforeAll(async () => {
    const email = `tracked${Date.now()}@example.com`;
    const res = await request(app).post('/api/auth/register').send({ email, password: 'password123' });
    token = res.body.data.accessToken;
    userId = (await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM transactions WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM accounts WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM categories WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  });

  const create = (body: object) => request(app).post('/api/accounts').set(auth()).send(body);
  const update = (id: number, body: object) => request(app).put(`/api/accounts/${id}`).set(auth()).send(body);
  const addTransaction = (accountId: number) =>
    pool.query(
      `INSERT INTO transactions (user_id, category_id, credit_account_id, debit, credit, date)
       VALUES ($1, 3, $2, 100, 100, '2026-01-01')`,
      [userId, accountId]
    );

  describe('create', () => {
    it('creates a tracked wallet at scale 8 and flags it', async () => {
      const res = await create({ name: 'Cold', currency: 'BTC', startBalance: 0, ...WALLET });
      expect(res.status).toBe(200);
      expect(res.body.data.tracked).toBe(true);
      expect(res.body.data.scale).toBe(8);
    });

    it('rejects a non-zero start balance', async () => {
      const res = await create({ name: 'Cold', currency: 'BTC', startBalance: 1, ...WALLET });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/starts at 0/);
    });

    it("rejects a currency other than the chain's", async () => {
      const res = await create({ name: 'Cold', currency: 'EUR', startBalance: 0, ...WALLET });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/BTC/);
    });

    it('leaves a crypto account without an address untracked', async () => {
      const res = await create({
        name: 'Exchange', currency: 'BTC', startBalance: 5, type: 'crypto', settings: { blockchain: 'bitcoin' },
      });
      expect(res.status).toBe(200);
      expect(res.body.data.tracked).toBe(false);
    });

    it('leaves an unsupported chain untracked', async () => {
      const res = await create({
        name: 'Eth', currency: 'ETH', startBalance: 5, type: 'crypto', settings: { address: '0xabc', blockchain: 'ethereum' },
      });
      expect(res.status).toBe(200);
      expect(res.body.data.tracked).toBe(false);
    });

    it('flags accounts in GET /api/accounts', async () => {
      const created = await create({ name: 'Listed', currency: 'BTC', startBalance: 0, ...WALLET });
      const res = await request(app).get('/api/accounts').set(auth());
      const listed = res.body.data.find((a: any) => a.id === created.body.data.id);
      expect(listed.tracked).toBe(true);
    });
  });

  describe('update', () => {
    it('makes an empty, zero-balance account tracked', async () => {
      const plain = await create({ name: 'Later', currency: 'BTC', startBalance: 0, type: 'crypto', settings: {} });
      const res = await update(plain.body.data.id, { name: 'Later', currency: 'BTC', startBalance: 0, ...WALLET });
      expect(res.status).toBe(200);
      expect(res.body.data.tracked).toBe(true);
      expect(res.body.data.scale).toBe(8);
    });

    it('refuses to track an account that has transactions', async () => {
      const plain = await create({ name: 'Used', currency: 'BTC', startBalance: 0, type: 'crypto', settings: {} });
      await addTransaction(plain.body.data.id);
      const res = await update(plain.body.data.id, { name: 'Used', currency: 'BTC', startBalance: 0, ...WALLET });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/create a new account/);
    });

    it('refuses to track an account with a start balance', async () => {
      const plain = await create({ name: 'Funded', currency: 'BTC', startBalance: 1, type: 'crypto', settings: {} });
      const res = await update(plain.body.data.id, { name: 'Funded', currency: 'BTC', startBalance: 0, ...WALLET });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/create a new account/);
    });

    it('refuses a start balance change on a tracked account', async () => {
      const w = await create({ name: 'W1', currency: 'BTC', startBalance: 0, ...WALLET });
      const res = await update(w.body.data.id, { name: 'W1', currency: 'BTC', startBalance: 2, ...WALLET });
      expect(res.status).toBe(400);
    });

    it('allows renaming a tracked account that has transactions', async () => {
      const w = await create({ name: 'W2', currency: 'BTC', startBalance: 0, ...WALLET });
      await addTransaction(w.body.data.id);
      const res = await update(w.body.data.id, { name: 'W2 renamed', currency: 'BTC', startBalance: 0, ...WALLET });
      expect(res.status).toBe(200);
      expect(res.body.data.name).toBe('W2 renamed');
    });

    it('refuses an address change once transactions exist', async () => {
      const w = await create({ name: 'W3', currency: 'BTC', startBalance: 0, ...WALLET });
      await addTransaction(w.body.data.id);
      const res = await update(w.body.data.id, {
        name: 'W3', currency: 'BTC', startBalance: 0, type: 'crypto', settings: { address: 'bc1qother', blockchain: 'bitcoin' },
      });
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/wallet/);
    });

    it('allows an address change while the account is empty', async () => {
      const w = await create({ name: 'W4', currency: 'BTC', startBalance: 0, ...WALLET });
      const res = await update(w.body.data.id, {
        name: 'W4', currency: 'BTC', startBalance: 0, type: 'crypto', settings: { address: 'bc1qother', blockchain: 'bitcoin' },
      });
      expect(res.status).toBe(200);
      expect(res.body.data.settings.address).toBe('bc1qother');
    });

    it('untracks by removing the address, keeping transactions', async () => {
      const w = await create({ name: 'W5', currency: 'BTC', startBalance: 0, ...WALLET });
      await addTransaction(w.body.data.id);
      const res = await update(w.body.data.id, {
        name: 'W5', currency: 'BTC', startBalance: 0, type: 'crypto', settings: { blockchain: 'bitcoin' },
      });
      expect(res.status).toBe(200);
      expect(res.body.data.tracked).toBe(false);
      const count = await pool.query('SELECT COUNT(*)::int AS n FROM transactions WHERE credit_account_id = $1', [w.body.data.id]);
      expect(count.rows[0].n).toBe(1);
    });
  });
});
