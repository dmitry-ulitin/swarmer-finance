import request from 'supertest';
import { createTestApp } from './testApp';
import { pool } from '../db';
import { tronProvider } from '../services/chain/tron';
import { ChainTx } from '../services/chain';
import { syncAccount } from '../services/chainSync';

const app = createTestApp();
const ADDR = 'TPJe9tgEJFsgVTQ4gLjzRTCrQ6pRJYc1aS';
const OTHER = 'TPTMUtEBqk3G1Pci3YKpcbEBRjnG4kLU1b';
// The account-rule tests use their own address: several USDT accounts on
// ADDR would make the sync tests' peer lookup ambiguous.
const RULES = 'TRulesAddressForAccountTests00000';

describe('TRON sync', () => {
  let token: string;
  let userId: number;
  let spy: jest.SpyInstance;
  const auth = () => ({ Authorization: `Bearer ${token}` });
  // Per (address, currency) histories served by the mocked provider,
  // filtered by `known` exactly like the real one.
  const history = new Map<string, ChainTx[]>();
  const key = (address: string, currency: string) => `${address}/${currency}`;

  // Account DTOs convert balances through the rates API; keep it offline.
  const originalFetch = global.fetch;

  beforeAll(async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ date: new Date().toISOString().slice(0, 10), rates: {} }),
    }) as unknown as typeof fetch;
    const email = `tron${Date.now()}@example.com`;
    const res = await request(app).post('/api/auth/register').send({ email, password: 'password123' });
    token = res.body.data.accessToken;
    userId = (await pool.query('SELECT id FROM users WHERE email = $1', [email])).rows[0].id;
    spy = jest.spyOn(tronProvider, 'fetchNewTxs').mockImplementation(async (address, currency, known) =>
      (history.get(key(address, currency)) ?? []).filter(t => !known.has(t.txid))
    );
  });

  afterAll(async () => {
    spy.mockRestore();
    global.fetch = originalFetch;
    await pool.query('DELETE FROM transactions WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM accounts WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM categories WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  });

  beforeEach(() => history.clear());

  const create = (name: string, currency: string, address = ADDR) =>
    request(app).post('/api/accounts').set(auth())
      .send({ name, currency, startBalance: 0, type: 'crypto', settings: { address, blockchain: 'tron' } });
  const update = (id: number, name: string, currency: string, address = ADDR) =>
    request(app).put(`/api/accounts/${id}`).set(auth())
      .send({ name, currency, startBalance: 0, type: 'crypto', settings: { address, blockchain: 'tron' } });
  const rows = async (accountId: number) =>
    (await pool.query(
      `SELECT debit_account_id, credit_account_id, debit::int, credit::int, category_id, import_hash
       FROM transactions WHERE debit_account_id = $1 OR credit_account_id = $1 ORDER BY import_hash`,
      [accountId]
    )).rows;
  const seenCount = async (id: number) =>
    Number((await pool.query('SELECT COUNT(*) FROM chain_seen_txids WHERE account_id = $1', [id])).rows[0].count);
  const tx = (txid: string, fee: number, transfers: [string, number][]): ChainTx =>
    ({ txid, date: '2025-12-18', fee, transfers: transfers.map(([counterparty, amount]) => ({ counterparty, amount })) });

  describe('accounts', () => {
    it('creates tracked TRX and USDT accounts at scale 6', async () => {
      for (const currency of ['TRX', 'USDT']) {
        const res = await create(`W ${currency}`, currency, RULES);
        expect(res.status).toBe(200);
        expect(res.body.data).toMatchObject({ tracked: true, scale: 6, currency });
      }
    });

    it('rejects another currency', async () => {
      const res = await create('W EUR', 'EUR', RULES);
      expect(res.status).toBe(400);
      expect(res.body.error).toBe('A blockchain-synced account must be in TRX or USDT');
    });

    it('refuses a currency change once the account has synced', async () => {
      const id = (await create('Switch', 'TRX', RULES)).body.data.id;
      history.set(key(RULES, 'TRX'), [tx('s1', 0, [['Tfrom', 5]])]);
      await syncAccount(userId, id);
      const res = await update(id, 'Switch', 'USDT', RULES);
      expect(res.status).toBe(400);
      expect(res.body.error).toMatch(/wallet/);
    });

    it('treats a currency change before any sync as a wallet switch', async () => {
      const id = (await create('Switch2', 'TRX', RULES)).body.data.id;
      await pool.query(
        `INSERT INTO transactions (user_id, category_id, credit_account_id, debit, credit, date)
         VALUES ($1, 3, $2, 100, 100, '2026-01-01')`,
        [userId, id]
      );
      const res = await update(id, 'Switch2', 'USDT', RULES);
      expect(res.status).toBe(200);
      expect(res.body.data.currency).toBe('USDT');
      expect(await seenCount(id)).toBe(0);
    });
  });

  describe('syncAccount', () => {
    let trxAccount: number;
    let usdtAccount: number;
    let otherUsdt: number;

    beforeAll(async () => {
      trxAccount = (await create('Ledger TRX', 'TRX')).body.data.id;
      usdtAccount = (await create('Ledger USDT', 'USDT')).body.data.id;
      otherUsdt = (await create('Other USDT', 'USDT', OTHER)).body.data.id;
    });

    beforeEach(async () => {
      await pool.query('DELETE FROM transactions WHERE user_id = $1', [userId]);
      await pool.query('DELETE FROM chain_seen_txids WHERE account_id = ANY($1::int[])', [[trxAccount, usdtAccount, otherUsdt]]);
    });

    it('files the TRX fee of a USDT send on the TRX account, and none on the USDT one', async () => {
      history.set(key(ADDR, 'USDT'), [tx('u1', 0, [['Tshop', -200000000]])]);
      history.set(key(ADDR, 'TRX'), [tx('u1', 13028500, [])]);

      expect(await syncAccount(userId, usdtAccount)).toMatchObject({ added: 1, fees: 0 });
      expect(await syncAccount(userId, trxAccount)).toMatchObject({ added: 0, fees: 1 });

      expect(await rows(usdtAccount)).toEqual([
        { debit_account_id: usdtAccount, credit_account_id: null, debit: 200000000, credit: 200000000, category_id: 4, import_hash: 'u1' },
      ]);
      expect(await rows(trxAccount)).toEqual([
        { debit_account_id: trxAccount, credit_account_id: null, debit: 13028500, credit: 13028500, category_id: 5, import_hash: 'u1:fee' },
      ]);
    });

    it('does not treat the TRX and USDT accounts of one address as peers', async () => {
      // A TRX payment from ADDR to OTHER: OTHER has only a USDT account, so
      // it is an expense, not a transfer into the USDT wallet.
      history.set(key(ADDR, 'TRX'), [tx('t1', 0, [[OTHER, -500]])]);
      await syncAccount(userId, trxAccount);
      expect(await rows(trxAccount)).toEqual([
        { debit_account_id: trxAccount, credit_account_id: null, debit: 500, credit: 500, category_id: 4, import_hash: 't1' },
      ]);
      expect(await rows(otherUsdt)).toEqual([]);
    });

    it('files a USDT payment between two tracked USDT wallets as one transfer', async () => {
      history.set(key(ADDR, 'USDT'), [tx('p1', 0, [[OTHER, -700]])]);
      history.set(key(OTHER, 'USDT'), [tx('p1', 0, [[ADDR, 700]])]);
      await syncAccount(userId, usdtAccount);
      expect(await syncAccount(userId, otherUsdt)).toMatchObject({ added: 0, merged: 0 });
      expect(await rows(otherUsdt)).toEqual([
        { debit_account_id: usdtAccount, credit_account_id: otherUsdt, debit: 700, credit: 700, category_id: null, import_hash: 'p1' },
      ]);
    });

    it('marks an empty tx seen so it is not fetched again', async () => {
      history.set(key(ADDR, 'USDT'), [tx('fake', 0, [])]);
      expect(await syncAccount(userId, usdtAccount)).toEqual({ added: 0, merged: 0, fees: 0, adopted: 0, removed: 0 });
      expect(await seenCount(usdtAccount)).toBe(1);
    });
  });
});
