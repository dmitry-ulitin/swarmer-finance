import request from 'supertest';
import * as fs from 'fs';
import * as path from 'path';
import { createTestApp } from './testApp';
import { pool } from '../db';

const app = createTestApp();
const SENDER = 'bc1qda5r9p5l9l74r2gzuz992nvda8d2lezr2wzk56';
const RECEIVER = 'bc1q3yxr3gkes4nmjvtmn5h5qasyh7jzusxzezys75';
const realTx = JSON.parse(
  fs.readFileSync(path.join(__dirname, 'fixtures', 'chain', 'tx-95333b08.json'), 'utf8')
);

describe('POST /api/accounts/:id/sync', () => {
  let token: string;
  let userId: number;
  let sender: number;
  let receiver: number;
  const originalFetch = global.fetch;
  let fetchMock: jest.Mock;

  const respond = (status: number, body: unknown) =>
    Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body } as Response);

  beforeAll(async () => {
    const email = `syncapi${Date.now()}@example.com`;
    const res = await request(app).post('/api/auth/register').send({ email, password: 'password123' });
    token = res.body.data.accessToken;
    userId = (await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id;
    const wallet = async (name: string, address: string) =>
      (await pool.query(
        `INSERT INTO accounts (user_id, name, currency, scale, start_balance, type, settings)
         VALUES ($1, $2, 'BTC', 8, 0, 'crypto', $3) RETURNING id`,
        [userId, name, JSON.stringify({ address, blockchain: 'bitcoin' })]
      )).rows[0].id as number;
    sender = await wallet('Sender', SENDER);
    receiver = await wallet('Receiver', RECEIVER);
  });

  beforeEach(() => {
    fetchMock = jest.fn((url: string) =>
      url.includes('/address/') ? respond(200, [realTx]) : respond(404, null)
    );
    global.fetch = fetchMock as unknown as typeof fetch;
  });

  afterAll(async () => {
    global.fetch = originalFetch;
    await pool.query('DELETE FROM transactions WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM accounts WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM categories WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  });

  const sync = (id: number) =>
    request(app).post(`/api/accounts/${id}/sync`).set({ Authorization: `Bearer ${token}` });

  it('requires authentication', async () => {
    const res = await request(app).post(`/api/accounts/${sender}/sync`);
    expect(res.status).toBe(401);
  });

  it('syncs a real payment into transfer, expense and fee, then reports up to date', async () => {
    const first = await sync(sender);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ data: { added: 2, merged: 0, fees: 1 }, error: null });

    const rows = await pool.query(
      `SELECT debit_account_id, credit_account_id, debit::bigint::text AS debit, category_id, payee, import_hash
       FROM transactions WHERE debit_account_id = $1 ORDER BY import_hash`,
      [sender]
    );
    expect(rows.rows).toEqual([
      { debit_account_id: sender, credit_account_id: receiver, debit: '146435', category_id: null, payee: RECEIVER, import_hash: realTx.txid },
      { debit_account_id: sender, credit_account_id: null, debit: '9214', category_id: 5, payee: null, import_hash: `${realTx.txid}:fee` },
      { debit_account_id: sender, credit_account_id: null, debit: '238484212', category_id: 4, payee: 'bc1qy0rlysheyqwrjhs6e8ya82urst9d479wa24mrn', import_hash: `${realTx.txid}:out` },
    ]);

    const again = await sync(receiver);
    expect(again.body.data).toEqual({ added: 0, merged: 0, fees: 0 });
  });

  it('maps an unreachable API to 502', async () => {
    fetchMock.mockImplementation(() => Promise.reject(new Error('ECONNREFUSED')));
    const res = await sync(sender);
    expect(res.status).toBe(502);
    expect(res.body.error).toBe('Blockchain API unavailable');
  });

  it('maps a rejected address to 400', async () => {
    fetchMock.mockImplementation(() => respond(400, 'Invalid Bitcoin address'));
    const res = await sync(sender);
    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid address');
  });
});
