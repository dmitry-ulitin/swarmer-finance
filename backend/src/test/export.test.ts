import request from 'supertest';
import { createTestApp } from './testApp';
import { pool } from '../db';
import { formatAmount } from '../services/export';
import { parseCsv } from '../services/import/csv';

const app = createTestApp();

async function register(prefix: string): Promise<{ token: string; userId: number }> {
  const email = `${prefix}${Date.now()}@example.com`;
  const res = await request(app).post('/api/auth/register').send({ email, password: 'password123' });
  const user = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
  return { token: res.body.data.accessToken, userId: user.rows[0].id };
}

async function insertCategory(userId: number, name: string, parentId: number): Promise<number> {
  const r = await pool.query(
    `INSERT INTO categories (user_id, name, parent_id) VALUES ($1, $2, $3) RETURNING id`,
    [userId, name, parentId]
  );
  return r.rows[0].id;
}

async function insertAccount(userId: number, name: string, currency: string, scale: number): Promise<number> {
  const r = await pool.query(
    `INSERT INTO accounts (user_id, name, currency, start_balance, scale) VALUES ($1, $2, $3, 0, $4) RETURNING id`,
    [userId, name, currency, scale]
  );
  return r.rows[0].id;
}

async function insertTx(
  userId: number,
  t: { category?: number; debitAccount?: number; creditAccount?: number; debit: number; credit: number;
    date: string; description?: string; payee?: string }
): Promise<number> {
  const r = await pool.query(
    `INSERT INTO transactions (user_id, category_id, debit_account_id, credit_account_id, debit, credit, date, description, payee)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9) RETURNING id`,
    [userId, t.category ?? null, t.debitAccount ?? null, t.creditAccount ?? null, t.debit, t.credit, t.date,
      t.description ?? '', t.payee ?? null]
  );
  return r.rows[0].id;
}

describe('formatAmount', () => {
  it('writes integers at their scale without float drift', () => {
    expect(formatAmount(-12345, 2)).toBe('-123.45');
    expect(formatAmount(5, 2)).toBe('0.05');
    expect(formatAmount(-1, 8)).toBe('-0.00000001');
    expect(formatAmount(1500, 0)).toBe('1500');
  });
});

describe('GET /api/transactions/export', () => {
  let token: string;
  let userId: number;
  let otherToken: string;
  let otherUserId: number;
  let eur: number;
  let btc: number;
  let cash: number;
  let otherAccount: number;
  let expenseId: number;
  let transferId: number;

  const exportCsv = (query = '', as = token) =>
    request(app).get(`/api/transactions/export${query}`).set({ Authorization: `Bearer ${as}` });
  const grid = (text: string) => parseCsv(text);

  beforeAll(async () => {
    ({ token, userId } = await register('exp'));
    ({ token: otherToken, userId: otherUserId } = await register('expother'));

    const food = await insertCategory(userId, 'ExpFood', 2);
    const cafe = await insertCategory(userId, 'ExpCafe', food);
    const salary = await insertCategory(userId, 'ExpSalary', 1);

    eur = await insertAccount(userId, 'Main EUR', 'EUR', 2);
    btc = await insertAccount(userId, 'Cold BTC', 'BTC', 8);
    cash = await insertAccount(userId, 'Cash', 'EUR', 2);
    otherAccount = await insertAccount(otherUserId, 'Foreign', 'EUR', 2);

    await insertTx(userId, { category: salary, creditAccount: eur, debit: 300000, credit: 300000, date: '2026-01-05',
      description: 'January' });
    expenseId = await insertTx(userId, { category: cafe, debitAccount: eur, debit: 1250, credit: 1250, date: '2026-01-10',
      description: 'Coffee, "large"', payee: 'Cafe Nero' });
    transferId = await insertTx(userId, { debitAccount: eur, creditAccount: btc, debit: 100000, credit: 1234567,
      date: '2026-01-15', description: 'Buy BTC' });
    await insertTx(userId, { debitAccount: eur, creditAccount: cash, debit: 5000, credit: 5000, date: '2026-01-20' });
    await insertTx(otherUserId, { category: 4, debitAccount: otherAccount, debit: 999, credit: 999, date: '2026-01-12' });
  });

  it('requires authentication', async () => {
    const res = await request(app).get('/api/transactions/export');
    expect(res.status).toBe(401);
  });

  it('writes a CSV with a BOM, a header and oldest rows first', async () => {
    const res = await exportCsv();
    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/text\/csv/);
    expect(res.headers['content-disposition']).toMatch(/attachment; filename="statement-\d{4}-\d{2}-\d{2}\.csv"/);
    expect(res.text.startsWith('﻿')).toBe(true);

    const [header, ...rows] = grid(res.text);
    expect(header).toEqual(['Date', 'Account', 'Type', 'Category', 'Amount', 'Currency',
      'Counter account', 'Counter amount', 'Counter currency', 'Payee', 'Description', 'Id']);
    expect(rows.map(r => r[0])).toEqual([...rows.map(r => r[0])].sort());
  });

  it('writes one row per exported side of each transaction', async () => {
    const rows = grid((await exportCsv()).text).slice(1);
    // Income, expense, two sides of EUR→BTC, two sides of EUR→Cash.
    expect(rows).toHaveLength(6);

    expect(rows.find(r => r[11] === String(expenseId))).toEqual([
      '2026-01-10', 'Main EUR', 'expense', 'ExpFood / ExpCafe', '-12.50', 'EUR', '', '', '',
      'Cafe Nero', 'Coffee, "large"', String(expenseId),
    ]);
    const transfer = rows.filter(r => r[11] === String(transferId));
    expect(transfer).toEqual([
      ['2026-01-15', 'Main EUR', 'transfer', '', '-1000.00', 'EUR', 'Cold BTC', '0.01234567', 'BTC', '', 'Buy BTC',
        String(transferId)],
      ['2026-01-15', 'Cold BTC', 'transfer', '', '0.01234567', 'BTC', 'Main EUR', '-1000.00', 'EUR', '', 'Buy BTC',
        String(transferId)],
    ]);
  });

  it('writes only the filtered account side of a transfer leaving the filter', async () => {
    const rows = grid((await exportCsv(`?accounts=${btc}`)).text).slice(1);
    expect(rows).toHaveLength(1);
    expect(rows[0][1]).toBe('Cold BTC');
  });

  it('applies the list filters', async () => {
    const rows = grid((await exportCsv('?type=expense&from=2026-01-01&to=2026-01-31')).text).slice(1);
    expect(rows.map(r => r[11])).toEqual([String(expenseId)]);
  });

  it('never includes accounts the caller cannot reach', async () => {
    const rows = grid((await exportCsv(`?accounts=${otherAccount}`)).text).slice(1);
    // As in the list: a filter of only unreachable accounts matches nothing.
    expect(rows).toHaveLength(0);

    const theirs = grid((await exportCsv('', otherToken)).text).slice(1);
    expect(theirs.map(r => r[1])).toEqual(['Foreign']);
  });

  it('previews the scale of the export', async () => {
    const res = await exportCsv('?preview=true');
    expect(res.status).toBe(200);
    expect(res.body.data).toEqual({ rows: 6, accounts: 3, from: '2026-01-05', to: '2026-01-20' });

    const empty = await exportCsv('?preview=true&from=2030-01-01');
    expect(empty.body.data).toEqual({ rows: 0, accounts: 0, from: null, to: null });
  });

  describe('importing the export back', () => {
    let target: number;
    let targetBtc: number;

    beforeAll(async () => {
      target = await insertAccount(userId, 'Restored', 'EUR', 2);
      targetBtc = await insertAccount(userId, 'Cold BTC', 'BTC', 8);
    });

    const parse = async (accountId: number, sourceAccount?: string) => {
      const content = Buffer.from((await exportCsv(`?accounts=${eur}&accounts=${btc}`)).text).toString('base64');
      return request(app)
        .post('/api/import/parse')
        .set({ Authorization: `Bearer ${token}` })
        .send({ accountId, content, ...(sourceAccount ? { sourceAccount } : {}) });
    };

    it('is recognised and reads the chosen account', async () => {
      const res = await parse(target, 'Main EUR');
      expect(res.status).toBe(200);
      expect(res.body.data.format).toBe('swarmer');
      expect(res.body.data.sourceAccounts).toEqual(['Main EUR', 'Cold BTC']);
      expect(res.body.data.sourceAccount).toBe('Main EUR');
      expect(res.body.data.rows.map((r: { amount: number }) => r.amount)).toEqual([3000, -12.5, -1000, -50]);
      expect(res.body.data.rows[1]).toMatchObject({ payee: 'Cafe Nero', description: 'Coffee, "large"' });
    });

    it('defaults to the file account with the target account name, keeping its precision', async () => {
      const res = await parse(targetBtc);
      expect(res.body.data.sourceAccount).toBe('Cold BTC');
      expect(res.body.data.rows.map((r: { amount: number }) => r.amount)).toEqual([0.01234567]);
    });

    it('defaults to the first account when no name matches', async () => {
      const res = await parse(target);
      expect(res.body.data.sourceAccount).toBe('Main EUR');
    });

    it('refuses an account the file does not have', async () => {
      const res = await parse(target, 'Nope');
      expect(res.status).toBe(400);
    });

    it('marks every row a duplicate once imported', async () => {
      const first = await parse(targetBtc);
      const reconciled = await request(app)
        .post('/api/import/reconcile')
        .set({ Authorization: `Bearer ${token}` })
        .send({ accountId: targetBtc, rows: first.body.data.rows });
      expect(reconciled.status).toBe(200);
      const stored = await pool.query('SELECT credit FROM transactions WHERE credit_account_id = $1', [targetBtc]);
      expect(stored.rows.map(r => Number(r.credit))).toEqual([1234567]);

      const again = await parse(targetBtc);
      expect(again.body.data.summary).toMatchObject({ total: 1, duplicate: 1 });
    });
  });
});
