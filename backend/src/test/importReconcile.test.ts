import * as fs from 'fs';
import * as path from 'path';
import { pool } from '../db';
import { parseStatement, reconcile } from '../services/import';

const fixtureB64 = (...p: string[]) =>
  fs.readFileSync(path.join(__dirname, 'fixtures', 'banks', ...p)).toString('base64');

describe('reconcile', () => {
  let userId: number;
  let otherUserId: number;
  let thirdUserId: number;
  let accountId: number;
  let ownerCategoryId: number;
  let unrelatedCategoryId: number;
  let eurPeerId: number;
  let usdPeerId: number;
  let xtsPeerId: number;
  let unrelatedPeerId: number;
  let trackedPeerId: number;

  beforeAll(async () => {
    const mk = async (email: string) => {
      const u = await pool.query(
        `INSERT INTO users (email, password_hash, name, currency)
         VALUES ($1, 'x', 'Rec Test', 'EUR') RETURNING id`,
        [email]
      );
      return u.rows[0].id as number;
    };
    userId = await mk(`rec${Date.now()}@example.com`);
    otherUserId = await mk(`recb${Date.now()}@example.com`);
    thirdUserId = await mk(`recc${Date.now()}@example.com`);
    const a = await pool.query(
      `INSERT INTO accounts (user_id, name, currency, start_balance)
       VALUES ($1, 'Rec Account', 'EUR', 0) RETURNING id`,
      [userId]
    );
    accountId = a.rows[0].id;

    const ownerCat = await pool.query(
      `INSERT INTO categories (user_id, name, parent_id, color, icon)
       VALUES ($1, 'Owner Cat', 2, '#123456', 'tag') RETURNING id`,
      [userId]
    );
    ownerCategoryId = ownerCat.rows[0].id;

    // Owned by thirdUserId, who shares nothing with userId (the account
    // owner) or otherUserId.
    const unrelatedCat = await pool.query(
      `INSERT INTO categories (user_id, name, parent_id, color, icon)
       VALUES ($1, 'Unrelated Cat', 2, '#123456', 'tag') RETURNING id`,
      [thirdUserId]
    );
    unrelatedCategoryId = unrelatedCat.rows[0].id;

    const mkAccount = async (ownerId: number, currency: string, type = 'bank', settings = {}) => {
      const r = await pool.query(
        `INSERT INTO accounts (user_id, name, currency, start_balance, type, settings)
         VALUES ($1, 'Peer', $2, 0, $3, $4) RETURNING id`,
        [ownerId, currency, type, settings]
      );
      return r.rows[0].id as number;
    };
    eurPeerId = await mkAccount(userId, 'EUR');
    usdPeerId = await mkAccount(userId, 'USD');
    // ISO 4217's code reserved for testing: no provider quotes it.
    xtsPeerId = await mkAccount(userId, 'XTS');
    unrelatedPeerId = await mkAccount(thirdUserId, 'EUR');
    trackedPeerId = await mkAccount(userId, 'BTC', 'crypto', {
      blockchain: 'bitcoin',
      address: 'bc1qtrackedpeer',
    });
  });

  afterAll(async () => {
    for (const id of [userId, otherUserId, thirdUserId]) {
      await pool.query('DELETE FROM transactions WHERE user_id = $1', [id]);
      await pool.query('DELETE FROM accounts WHERE user_id = $1', [id]);
      await pool.query('DELETE FROM categories WHERE user_id = $1', [id]);
      await pool.query('DELETE FROM users WHERE id = $1', [id]);
    }
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM transactions WHERE user_id = $1', [userId]);
  });

  const parsed = () => parseStatement(userId, accountId, fixtureB64('lhv', 'statement.csv'));

  it('creates one transaction per row', async () => {
    const { rows } = await parsed();
    const result = await reconcile(userId, accountId, rows);
    expect(result.created).toBe(143);
    expect(result.skipped).toBe(0);
  });

  it('is idempotent — the same payload twice creates nothing the second time', async () => {
    const { rows } = await parsed();
    await reconcile(userId, accountId, rows);
    const second = await reconcile(userId, accountId, rows);
    expect(second.created).toBe(0);
    expect(second.skipped).toBe(143);
  });

  it('round-trips: after reconcile, re-parsing flags every row duplicate', async () => {
    const { rows } = await parsed();
    await reconcile(userId, accountId, rows);
    const again = await parsed();
    expect(again.summary.duplicate).toBe(143);
    expect(again.summary.new).toBe(0);
  });

  it('stores four distinct transactions for the four identical rows', async () => {
    const { rows } = await parsed();
    await reconcile(userId, accountId, rows);
    const dupes = await pool.query(
      `SELECT COUNT(*) FROM transactions
       WHERE user_id = $1 AND date = '2026-07-29' AND debit = 1000`,
      [userId]
    );
    expect(Number(dupes.rows[0].count)).toBe(4);
  });

  it('routes a negative amount to debit and a positive to credit', async () => {
    const { rows } = await parsed();
    await reconcile(userId, accountId, rows);
    const expenses = await pool.query(
      `SELECT COUNT(*) FROM transactions
       WHERE user_id = $1 AND debit_account_id = $2 AND credit_account_id IS NULL`,
      [userId, accountId]
    );
    const incomes = await pool.query(
      `SELECT COUNT(*) FROM transactions
       WHERE user_id = $1 AND credit_account_id = $2 AND debit_account_id IS NULL`,
      [userId, accountId]
    );
    expect(Number(expenses.rows[0].count)).toBe(133);
    expect(Number(incomes.rows[0].count)).toBe(10);
  });

  it('converts decimals to cents using the account scale', async () => {
    const { rows } = await parsed();
    await reconcile(userId, accountId, [rows[0]]);
    const t = await pool.query(
      'SELECT credit FROM transactions WHERE user_id = $1', [userId]
    );
    expect(Number(t.rows[0].credit)).toBe(130528);
  });

  it('assigns the uncategorized defaults when no category is given', async () => {
    const { rows } = await parsed();
    await reconcile(userId, accountId, [rows[0]]);
    const t = await pool.query(
      'SELECT category_id FROM transactions WHERE user_id = $1', [userId]
    );
    expect(t.rows[0].category_id).toBe(3); // income
  });

  it('imports a row the user kept despite a possible_duplicate flag', async () => {
    await pool.query(
      `INSERT INTO transactions
         (user_id, category_id, credit_account_id, debit, credit, date, description)
       VALUES ($1, 3, $2, 130528, 130528, '2026-07-01', 'typed by hand')`,
      [userId, accountId]
    );
    const { rows } = await parsed();
    expect(rows[0].status).toBe('possible_duplicate');
    // The heuristic is advisory: reconcile must NOT re-apply it and silently
    // drop the row the user decided to keep.
    const result = await reconcile(userId, accountId, [rows[0]]);
    expect(result.created).toBe(1);
  });

  it('refuses an account the user cannot reach with 403', async () => {
    const { rows } = await parsed();
    await expect(reconcile(otherUserId, accountId, rows))
      .rejects.toMatchObject({ statusCode: 403 });
  });

  it('rejects a row with no hash', async () => {
    await expect(
      reconcile(userId, accountId, [
        { date: '2026-07-01', amount: -5, hash: '' } as never,
      ])
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('round-trips payee from parse through reconcile into the stored transaction', async () => {
    const { rows } = await parsed();
    expect(rows[0].payee).toBe('MERCHANT 001');
    await reconcile(userId, accountId, [rows[0]]);
    const t = await pool.query(
      'SELECT payee FROM transactions WHERE user_id = $1', [userId]
    );
    expect(t.rows[0].payee).toBe('MERCHANT 001');
  });

  it('imports a row carrying a category the account owner holds', async () => {
    const { rows } = await parsed();
    const result = await reconcile(userId, accountId, [
      { ...rows[0], categoryId: ownerCategoryId },
    ]);
    expect(result.created).toBe(1);
    const t = await pool.query(
      'SELECT category_id FROM transactions WHERE user_id = $1', [userId]
    );
    expect(t.rows[0].category_id).toBe(ownerCategoryId);
  });

  it('rejects a row carrying a category id owned by an unrelated user, with 403, and creates nothing', async () => {
    const { rows } = await parsed();
    await expect(
      reconcile(userId, accountId, [{ ...rows[0], categoryId: unrelatedCategoryId }])
    ).rejects.toMatchObject({ statusCode: 403 });
    const count = await pool.query(
      'SELECT COUNT(*) FROM transactions WHERE user_id = $1', [userId]
    );
    expect(Number(count.rows[0].count)).toBe(0);
  });

  it('rejects a row carrying a nonexistent category id with 403, not 500', async () => {
    const { rows } = await parsed();
    await expect(
      reconcile(userId, accountId, [{ ...rows[0], categoryId: 999999 }])
    ).rejects.toMatchObject({ statusCode: 403 });
    const count = await pool.query(
      'SELECT COUNT(*) FROM transactions WHERE user_id = $1', [userId]
    );
    expect(Number(count.rows[0].count)).toBe(0);
  });

  describe('transfers', () => {
    const today = new Date().toISOString().slice(0, 10);
    const originalFetch = global.fetch;

    beforeAll(async () => {
      await pool.query(
        `INSERT INTO exchange_rates (from_currency, to_currency, rate, as_of)
         VALUES ('EUR', 'USD', 1.1, $1)
         ON CONFLICT (from_currency, to_currency, as_of) DO UPDATE SET rate = EXCLUDED.rate`,
        [today]
      );
    });

    afterAll(async () => {
      await pool.query(
        `DELETE FROM exchange_rates WHERE from_currency = 'EUR' AND to_currency = 'USD' AND as_of = $1`,
        [today]
      );
    });

    afterEach(() => {
      global.fetch = originalFetch;
    });

    const countRows = async () =>
      Number((await pool.query('SELECT COUNT(*) FROM transactions WHERE user_id = $1', [userId])).rows[0].count);

    it('stores an outgoing row as a transfer to the peer, without a category', async () => {
      await reconcile(userId, accountId, [
        { date: '2026-07-02', amount: -25.5, hash: 'tr-out', transferAccountId: eurPeerId },
      ]);
      const t = await pool.query(
        `SELECT debit_account_id, credit_account_id, debit, credit, category_id, import_hash
         FROM transactions WHERE user_id = $1`,
        [userId]
      );
      expect(t.rows[0]).toMatchObject({
        debit_account_id: accountId,
        credit_account_id: eurPeerId,
        category_id: null,
        import_hash: 'tr-out',
      });
      expect(Number(t.rows[0].debit)).toBe(2550);
      expect(Number(t.rows[0].credit)).toBe(2550);
    });

    it('stores an incoming row as a transfer from the peer', async () => {
      await reconcile(userId, accountId, [
        { date: '2026-07-02', amount: 10, hash: 'tr-in', transferAccountId: eurPeerId },
      ]);
      const t = await pool.query(
        'SELECT debit_account_id, credit_account_id FROM transactions WHERE user_id = $1',
        [userId]
      );
      expect(t.rows[0]).toMatchObject({ debit_account_id: eurPeerId, credit_account_id: accountId });
    });

    it('ignores a category sent alongside a transfer', async () => {
      await reconcile(userId, accountId, [
        {
          date: '2026-07-02', amount: -1, hash: 'tr-cat',
          transferAccountId: eurPeerId, categoryId: ownerCategoryId,
        },
      ]);
      const t = await pool.query('SELECT category_id FROM transactions WHERE user_id = $1', [userId]);
      expect(t.rows[0].category_id).toBeNull();
    });

    it('converts the peer side at the current rate when currencies differ', async () => {
      await reconcile(userId, accountId, [
        { date: '2026-07-02', amount: -100, hash: 'tr-fx', transferAccountId: usdPeerId },
      ]);
      const t = await pool.query('SELECT debit, credit FROM transactions WHERE user_id = $1', [userId]);
      expect(Number(t.rows[0].debit)).toBe(10000);
      expect(Number(t.rows[0].credit)).toBe(11000);
    });

    it('rejects a transfer with no available rate with 400, and creates nothing', async () => {
      global.fetch = jest.fn().mockRejectedValue(new Error('offline')) as unknown as typeof fetch;
      jest.spyOn(console, 'error').mockImplementation(() => {});
      await expect(
        reconcile(userId, accountId, [
          { date: '2026-07-02', amount: -1, hash: 'ok', categoryId: null },
          { date: '2026-07-02', amount: -1, hash: 'tr-xts', transferAccountId: xtsPeerId },
        ])
      ).rejects.toMatchObject({ statusCode: 400 });
      expect(await countRows()).toBe(0);
      jest.restoreAllMocks();
    });

    it('rejects a peer the user cannot write to with 403, and creates nothing', async () => {
      await expect(
        reconcile(userId, accountId, [
          { date: '2026-07-02', amount: -1, hash: 'tr-x', transferAccountId: unrelatedPeerId },
        ])
      ).rejects.toMatchObject({ statusCode: 403 });
      expect(await countRows()).toBe(0);
    });

    it('rejects a blockchain-tracked peer with 403', async () => {
      await expect(
        reconcile(userId, accountId, [
          { date: '2026-07-02', amount: -1, hash: 'tr-t', transferAccountId: trackedPeerId },
        ])
      ).rejects.toMatchObject({ statusCode: 403 });
    });

    it('rejects a transfer to the imported account itself with 400', async () => {
      await expect(
        reconcile(userId, accountId, [
          { date: '2026-07-02', amount: -1, hash: 'tr-self', transferAccountId: accountId },
        ])
      ).rejects.toMatchObject({ statusCode: 400 });
    });
  });
});
