import request from 'supertest';
import { createTestApp } from './testApp';
import { pool } from '../db';
import { bitcoinProvider } from '../services/chain/bitcoin';
import { ChainTx } from '../services/chain';
import { planTx, syncAccount } from '../services/chainSync';
import { Account } from '../types';

const app = createTestApp();

describe('planTx', () => {
  const peer = { id: 9 } as Account;
  const peers = new Map([['bc1qpeer', peer]]);
  const base = { txid: 't', date: '2026-05-29' };

  it('files a receipt as income from the first sender', () => {
    const plan = planTx({ ...base, fee: 0, transfers: [{ counterparty: 'bc1qx', amount: 5000 }] }, peers);
    expect(plan).toEqual({ ...base, fee: 0, income: { amount: 5000, from: 'bc1qx', peer: undefined } });
  });

  it('marks a receipt from a synced wallet', () => {
    const plan = planTx({ ...base, fee: 0, transfers: [{ counterparty: 'bc1qpeer', amount: 5000 }] }, peers);
    expect(plan.income?.peer).toBe(peer);
  });

  it('splits a payment into transfer, expense and fee', () => {
    const plan = planTx({
      ...base, fee: 100, transfers: [
        { counterparty: 'bc1qx', amount: -1000 },
        { counterparty: 'bc1qpeer', amount: -7000 },
        { counterparty: 'bc1qpeer', amount: -500 },
        { counterparty: 'bc1qy', amount: -2000 },
      ],
    }, peers);
    expect(plan).toEqual({
      ...base, fee: 100,
      transfer: { amount: 7500, peer },
      expense: { amount: 3000, to: 'bc1qx' },
    });
  });

  it('reduces a consolidation to its fee', () => {
    expect(planTx({ ...base, fee: 300, transfers: [] }, peers)).toEqual({ ...base, fee: 300 });
  });
});

describe('syncAccount', () => {
  let userId: number;
  let otherUserId: number;
  let walletA: number;
  let walletB: number;
  let exchange: number;
  let shop: number;
  let spy: jest.SpyInstance;
  // Per-address histories the mocked provider serves, filtered by `known`
  // exactly like the real one.
  const history = new Map<string, ChainTx[]>();

  const register = async (prefix: string) => {
    const email = `${prefix}${Date.now()}@example.com`;
    await request(app).post('/api/auth/register').send({ email, password: 'password123' });
    return (await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id as number;
  };
  const wallet = async (owner: number, name: string, settings: object) =>
    (await pool.query(
      `INSERT INTO accounts (user_id, name, currency, scale, start_balance, type, settings)
       VALUES ($1, $2, 'BTC', 8, 0, 'crypto', $3) RETURNING id`,
      [owner, name, JSON.stringify(settings)]
    )).rows[0].id as number;
  const rows = async (accountId: number) =>
    (await pool.query(
      `SELECT debit_account_id, credit_account_id, debit::int, credit::int, category_id, payee, import_hash
       FROM transactions WHERE debit_account_id = $1 OR credit_account_id = $1 ORDER BY import_hash`,
      [accountId]
    )).rows;

  beforeAll(async () => {
    userId = await register('sync');
    otherUserId = await register('syncother');
    walletA = await wallet(userId, 'A', { address: 'bc1qa', blockchain: 'bitcoin' });
    walletB = await wallet(userId, 'B', { address: 'bc1qb', blockchain: 'bitcoin' });
    exchange = await wallet(userId, 'Exchange', {});
    shop = (await pool.query(
      'SELECT id FROM categories WHERE user_id = $1 AND parent_id = 2 LIMIT 1', [userId]
    )).rows[0].id;
    spy = jest.spyOn(bitcoinProvider, 'fetchNewTxs').mockImplementation(async (address, known) =>
      (history.get(address) ?? []).filter(t => !known.has(t.txid))
    );
  });

  afterAll(async () => {
    spy.mockRestore();
    for (const id of [userId, otherUserId]) {
      await pool.query('DELETE FROM transactions WHERE user_id = $1', [id]);
      await pool.query('DELETE FROM account_shares WHERE user_id = $1', [id]);
      await pool.query('DELETE FROM accounts WHERE user_id = $1', [id]);
      await pool.query('DELETE FROM categories WHERE user_id = $1', [id]);
      await pool.query('DELETE FROM users WHERE id = $1', [id]);
    }
  });

  beforeEach(async () => {
    history.clear();
    await pool.query('DELETE FROM transactions WHERE user_id = ANY($1::int[])', [[userId, otherUserId]]);
    await pool.query(
      `UPDATE accounts SET settings = $2, deleted = false WHERE id = $1`,
      [walletB, JSON.stringify({ address: 'bc1qb', blockchain: 'bitcoin' })]
    );
  });

  const tx = (txid: string, fee: number, transfers: [string, number][]): ChainTx =>
    ({ txid, date: '2026-05-29', fee, transfers: transfers.map(([counterparty, amount]) => ({ counterparty, amount })) });

  it('files a receipt as uncategorised income', async () => {
    history.set('bc1qa', [tx('r1', 0, [['bc1qx', 5000]])]);
    await expect(syncAccount(userId, walletA)).resolves.toEqual({ added: 1, merged: 0, fees: 0 });
    expect(await rows(walletA)).toEqual([
      { debit_account_id: null, credit_account_id: walletA, debit: 5000, credit: 5000, category_id: 3, payee: 'bc1qx', import_hash: 'r1' },
    ]);
  });

  it('files a payment as expense plus a Network fees row', async () => {
    history.set('bc1qa', [tx('p1', 200, [['bc1qx', -3000]])]);
    await expect(syncAccount(userId, walletA)).resolves.toEqual({ added: 1, merged: 0, fees: 1 });
    expect(await rows(walletA)).toEqual([
      { debit_account_id: walletA, credit_account_id: null, debit: 3000, credit: 3000, category_id: 4, payee: 'bc1qx', import_hash: 'p1' },
      { debit_account_id: walletA, credit_account_id: null, debit: 200, credit: 200, category_id: 5, payee: null, import_hash: 'p1:fee' },
    ]);
  });

  it('files a consolidation as its fee alone', async () => {
    history.set('bc1qa', [tx('k1', 300, [])]);
    await expect(syncAccount(userId, walletA)).resolves.toEqual({ added: 0, merged: 0, fees: 1 });
    expect(await rows(walletA)).toHaveLength(1);
  });

  it('files a payment to another synced wallet as one transfer, and re-sync is a no-op', async () => {
    history.set('bc1qa', [tx('t1', 100, [['bc1qb', -7000], ['bc1qx', -1000]])]);
    history.set('bc1qb', [tx('t1', 0, [['bc1qa', 7000]])]);

    await expect(syncAccount(userId, walletA)).resolves.toEqual({ added: 2, merged: 0, fees: 1 });
    await expect(syncAccount(userId, walletB)).resolves.toEqual({ added: 0, merged: 0, fees: 0 });
    await expect(syncAccount(userId, walletA)).resolves.toEqual({ added: 0, merged: 0, fees: 0 });

    expect(await rows(walletA)).toEqual([
      { debit_account_id: walletA, credit_account_id: walletB, debit: 7000, credit: 7000, category_id: null, payee: 'bc1qb', import_hash: 't1' },
      { debit_account_id: walletA, credit_account_id: null, debit: 100, credit: 100, category_id: 5, payee: null, import_hash: 't1:fee' },
      { debit_account_id: walletA, credit_account_id: null, debit: 1000, credit: 1000, category_id: 4, payee: 'bc1qx', import_hash: 't1:out' },
    ]);
  });

  it('merges into the receiver row when the receiver synced first', async () => {
    history.set('bc1qb', [tx('t2', 0, [['bc1qa', 7000]])]);
    history.set('bc1qa', [tx('t2', 100, [['bc1qb', -7000]])]);

    await expect(syncAccount(userId, walletB)).resolves.toEqual({ added: 1, merged: 0, fees: 0 });
    await expect(syncAccount(userId, walletA)).resolves.toEqual({ added: 0, merged: 1, fees: 1 });

    expect(await rows(walletB)).toEqual([
      { debit_account_id: walletA, credit_account_id: walletB, debit: 7000, credit: 7000, category_id: null, payee: 'bc1qa', import_hash: 't2' },
    ]);
  });

  it('overrides a hand-set transfer source on the receiver row', async () => {
    history.set('bc1qb', [tx('t3', 0, [['bc1qa', 7000]])]);
    history.set('bc1qa', [tx('t3', 100, [['bc1qb', -7000]])]);
    await syncAccount(userId, walletB);
    await pool.query(
      `UPDATE transactions SET debit_account_id = $1, category_id = NULL WHERE import_hash = 't3'`,
      [exchange]
    );

    await expect(syncAccount(userId, walletA)).resolves.toEqual({ added: 0, merged: 1, fees: 1 });
    const [merged] = await rows(walletB);
    expect(merged.debit_account_id).toBe(walletA);
  });

  it('merges into the sender row when the receiver became synced later, splitting off the rest', async () => {
    await pool.query(`UPDATE accounts SET settings = '{}' WHERE id = $1`, [walletB]);
    history.set('bc1qa', [tx('t4', 100, [['bc1qb', -7000], ['bc1qx', -1000]])]);
    await expect(syncAccount(userId, walletA)).resolves.toEqual({ added: 1, merged: 0, fees: 1 });
    await pool.query(`UPDATE transactions SET category_id = $1 WHERE import_hash = 't4'`, [shop]);

    await pool.query(
      `UPDATE accounts SET settings = $2 WHERE id = $1`,
      [walletB, JSON.stringify({ address: 'bc1qb', blockchain: 'bitcoin' })]
    );
    history.set('bc1qb', [tx('t4', 0, [['bc1qa', 7000]])]);
    await expect(syncAccount(userId, walletB)).resolves.toEqual({ added: 0, merged: 1, fees: 0 });

    expect(await rows(walletA)).toEqual([
      { debit_account_id: walletA, credit_account_id: walletB, debit: 7000, credit: 7000, category_id: null, payee: 'bc1qb', import_hash: 't4' },
      { debit_account_id: walletA, credit_account_id: null, debit: 100, credit: 100, category_id: 5, payee: null, import_hash: 't4:fee' },
      { debit_account_id: walletA, credit_account_id: null, debit: 1000, credit: 1000, category_id: shop, payee: 'bc1qb', import_hash: 't4:out' },
    ]);
  });

  it('suggests categories from history by payee', async () => {
    for (let i = 0; i < 3; i++) {
      await pool.query(
        `INSERT INTO transactions (user_id, category_id, debit_account_id, debit, credit, date, payee)
         VALUES ($1, $2, $3, 10, 10, '2026-01-01', 'bc1qshop')`,
        [userId, shop, exchange]
      );
    }
    history.set('bc1qa', [tx('s1', 0, [['bc1qshop', -500]])]);
    await syncAccount(userId, walletA);
    const [expense] = (await rows(walletA)).filter(r => r.import_hash === 's1');
    expect(expense.category_id).toBe(shop);
  });

  it('files rows with categories resolved for the owner when a co-user syncs', async () => {
    const otherCategory = (await pool.query(
      'SELECT id FROM categories WHERE user_id = $1 AND parent_id = 2 LIMIT 1', [otherUserId]
    )).rows[0].id;
    await pool.query(
      'INSERT INTO account_shares (account_id, user_id, level) VALUES ($1, $2, 2), ($3, $2, 2)',
      [walletA, otherUserId, exchange]
    );
    try {
      for (let i = 0; i < 3; i++) {
        await pool.query(
          `INSERT INTO transactions (user_id, category_id, debit_account_id, debit, credit, date, payee)
           VALUES ($1, $2, $3, 10, 10, '2026-01-01', 'bc1qcafe')`,
          [otherUserId, otherCategory, exchange]
        );
      }
      history.set('bc1qa', [tx('s2', 0, [['bc1qcafe', -500]])]);
      await syncAccount(otherUserId, walletA);
      const [expense] = (await rows(walletA)).filter(r => r.import_hash === 's2');
      const owner = await pool.query('SELECT user_id FROM categories WHERE id = $1', [expense.category_id]);
      expect(owner.rows[0].user_id).toBe(userId);
    } finally {
      await pool.query('DELETE FROM account_shares WHERE user_id = $1', [otherUserId]);
    }
  });

  it('refuses a user without write access', async () => {
    history.set('bc1qa', [tx('x1', 0, [['bc1qx', 5000]])]);
    await expect(syncAccount(otherUserId, walletA)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('refuses an untracked account', async () => {
    await expect(syncAccount(userId, exchange)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('refuses a deleted account', async () => {
    await pool.query('UPDATE accounts SET deleted = true WHERE id = $1', [walletB]);
    await expect(syncAccount(userId, walletB)).rejects.toMatchObject({ statusCode: 403 });
  });

  it('writes nothing when the provider fails', async () => {
    spy.mockRejectedValueOnce({ statusCode: 502, message: 'Blockchain API unavailable' });
    await expect(syncAccount(userId, walletA)).rejects.toMatchObject({ statusCode: 502 });
    expect(await rows(walletA)).toEqual([]);
  });
});
