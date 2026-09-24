import * as fs from 'fs';
import * as path from 'path';
import { pool } from '../db';
import { parseStatement } from '../services/import';

const fixtureB64 = (...p: string[]) =>
  fs.readFileSync(path.join(__dirname, 'fixtures', 'banks', ...p)).toString('base64');

describe('parseStatement', () => {
  let userId: number;
  let otherUserId: number;
  let eurAccountId: number;
  let usdAccountId: number;
  let otherAccountId: number;
  let salaryCategoryId: number;
  let otherSalaryCategoryId: number;

  beforeAll(async () => {
    const mk = async (email: string) => {
      const u = await pool.query(
        `INSERT INTO users (email, password_hash, name, currency)
         VALUES ($1, 'x', 'Svc Test', 'EUR') RETURNING id`,
        [email]
      );
      return u.rows[0].id as number;
    };
    userId = await mk(`svc${Date.now()}@example.com`);
    otherUserId = await mk(`svcb${Date.now()}@example.com`);

    const eur = await pool.query(
      `INSERT INTO accounts (user_id, name, currency, start_balance)
       VALUES ($1, 'EUR Account', 'EUR', 0) RETURNING id`,
      [userId]
    );
    eurAccountId = eur.rows[0].id;
    const usd = await pool.query(
      `INSERT INTO accounts (user_id, name, currency, start_balance)
       VALUES ($1, 'USD Account', 'USD', 0) RETURNING id`,
      [userId]
    );
    usdAccountId = usd.rows[0].id;
    const other = await pool.query(
      `INSERT INTO accounts (user_id, name, currency, start_balance)
       VALUES ($1, 'Other EUR', 'EUR', 0) RETURNING id`,
      [otherUserId]
    );
    otherAccountId = other.rows[0].id;

    const mkIncomeCategory = async (ownerId: number) => {
      const c = await pool.query(
        `INSERT INTO categories (user_id, name, parent_id) VALUES ($1, 'Salary', 1) RETURNING id`,
        [ownerId]
      );
      return c.rows[0].id as number;
    };
    salaryCategoryId = await mkIncomeCategory(userId);
    otherSalaryCategoryId = await mkIncomeCategory(otherUserId);
  });

  afterAll(async () => {
    for (const id of [userId, otherUserId]) {
      await pool.query('DELETE FROM transactions WHERE user_id = $1', [id]);
      await pool.query('DELETE FROM accounts WHERE user_id = $1', [id]);
      await pool.query('DELETE FROM categories WHERE user_id = $1', [id]);
      await pool.query('DELETE FROM users WHERE id = $1', [id]);
    }
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM transactions WHERE user_id = ANY($1::int[])', [[userId, otherUserId]]);
    await pool.query('DELETE FROM account_shares WHERE account_id = $1', [otherAccountId]);
  });

  it('auto-detects LHV and returns every row as new', async () => {
    const result = await parseStatement(userId, eurAccountId, fixtureB64('lhv', 'statement.csv'));
    expect(result.format).toBe('lhv');
    expect(result.rows).toHaveLength(143);
    expect(result.summary.new).toBe(143);
    expect(result.summary.duplicate).toBe(0);
  });

  it('auto-detects Bank of Cyprus', async () => {
    const result = await parseStatement(
      userId, eurAccountId, fixtureB64('bank_of_cyprus', 'statement.csv')
    );
    expect(result.format).toBe('boc');
    expect(result.rows).toHaveLength(10);
  });

  it('honours an explicit format', async () => {
    const result = await parseStatement(
      userId, eurAccountId, fixtureB64('lhv', 'statement.csv'), 'lhv'
    );
    expect(result.format).toBe('lhv');
  });

  it('rejects an unknown explicit format with 400', async () => {
    await expect(
      parseStatement(userId, eurAccountId, fixtureB64('lhv', 'statement.csv'), 'nope')
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects an unrecognised file with 400', async () => {
    const junk = Buffer.from('foo,bar\n1,2\n').toString('base64');
    await expect(parseStatement(userId, eurAccountId, junk))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects a currency mismatch with 400', async () => {
    await expect(
      parseStatement(userId, usdAccountId, fixtureB64('lhv', 'statement.csv'))
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('refuses an account the user cannot reach with 403', async () => {
    await expect(
      parseStatement(otherUserId, eurAccountId, fixtureB64('lhv', 'statement.csv'))
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('refuses a nonexistent account with 403, not 404 — matching transactions.ts, so this endpoint cannot be used to enumerate account ids', async () => {
    await expect(
      parseStatement(userId, 999999, fixtureB64('lhv', 'statement.csv'))
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('writes nothing to the database', async () => {
    await parseStatement(userId, eurAccountId, fixtureB64('lhv', 'statement.csv'));
    const count = await pool.query(
      'SELECT COUNT(*) FROM transactions WHERE user_id = $1', [userId]
    );
    expect(Number(count.rows[0].count)).toBe(0);
  });

  it('flags an existing hash as duplicate', async () => {
    const first = await parseStatement(userId, eurAccountId, fixtureB64('lhv', 'statement.csv'));
    const hash = first.rows[0].hash;
    await pool.query(
      `INSERT INTO transactions
         (user_id, category_id, credit_account_id, debit, credit, date, description, import_hash)
       VALUES ($1, 3, $2, 130528, 130528, '2026-07-01', 'seed', $3)`,
      [userId, eurAccountId, hash]
    );
    const again = await parseStatement(userId, eurAccountId, fixtureB64('lhv', 'statement.csv'));
    expect(again.rows[0].status).toBe('duplicate');
    expect(again.summary.duplicate).toBe(1);
  });

  it('flags a hand-entered match as possible_duplicate, not duplicate', async () => {
    // Same date and amount as LHV row 0 (+1305.28), but no import_hash —
    // the shape of a transaction typed in by hand before importing began.
    await pool.query(
      `INSERT INTO transactions
         (user_id, category_id, credit_account_id, debit, credit, date, description)
       VALUES ($1, 3, $2, 130528, 130528, '2026-07-01', 'typed by hand')`,
      [userId, eurAccountId]
    );
    const result = await parseStatement(userId, eurAccountId, fixtureB64('lhv', 'statement.csv'));
    expect(result.rows[0].status).toBe('possible_duplicate');
    expect(result.rows[0].duplicateOf).toEqual(expect.any(Number));
  });

  it('does not flag an imported income as possible_duplicate of a hand-entered EXPENSE of the same magnitude and date', async () => {
    // LHV row 0 is an income of +1305.28 on 2026-07-01. A hand-entered
    // EXPENSE of the same magnitude on the same date is sign-opposite and
    // must not match — matching both signs was the bug (Finding 2).
    await pool.query(
      `INSERT INTO transactions
         (user_id, category_id, debit_account_id, debit, credit, date, description)
       VALUES ($1, 4, $2, 130528, 130528, '2026-07-01', 'hand-entered expense')`,
      [userId, eurAccountId]
    );
    const result = await parseStatement(userId, eurAccountId, fixtureB64('lhv', 'statement.csv'));
    expect(result.rows[0].status).toBe('new');
  });

  describe('category suggestions', () => {
    const seedIncome = (ownerId: number, accountId: number, categoryId: number, description: string | null = 'seed') =>
      pool.query(
        `INSERT INTO transactions
           (user_id, category_id, credit_account_id, debit, credit, date, description, payee)
         VALUES ($1, $2, $3, 1000, 1000, '2025-01-15', $4, 'Merchant 001')`,
        [ownerId, categoryId, accountId, description]
      );

    it('suggests the category the same payee was filed under before', async () => {
      await seedIncome(userId, eurAccountId, salaryCategoryId);
      const result = await parseStatement(userId, eurAccountId, fixtureB64('lhv', 'statement.csv'));
      expect(result.rows[0].suggestedCategoryId).toBe(salaryCategoryId);
      expect(result.rows[0].suggestionSource).toBe('payee');
    });

    it('learns from the user\'s other accounts, not just the one being imported into', async () => {
      await seedIncome(userId, usdAccountId, salaryCategoryId);
      const result = await parseStatement(userId, eurAccountId, fixtureB64('lhv', 'statement.csv'));
      expect(result.rows[0].suggestedCategoryId).toBe(salaryCategoryId);
    });

    it('ignores history on an account the user cannot access', async () => {
      await seedIncome(otherUserId, otherAccountId, otherSalaryCategoryId);
      const result = await parseStatement(userId, eurAccountId, fixtureB64('lhv', 'statement.csv'));
      expect(result.rows[0].suggestedCategoryId).toBeNull();
      expect(result.rows[0].suggestionSource).toBeNull();
    });

    it('ignores Uncategorized history', async () => {
      await seedIncome(userId, eurAccountId, 3);
      const result = await parseStatement(userId, eurAccountId, fixtureB64('lhv', 'statement.csv'));
      expect(result.rows[0].suggestedCategoryId).toBeNull();
    });

    it('tolerates history rows with a NULL description', async () => {
      await seedIncome(userId, eurAccountId, salaryCategoryId, null);
      const result = await parseStatement(userId, eurAccountId, fixtureB64('lhv', 'statement.csv'));
      expect(result.rows[0].suggestedCategoryId).toBe(salaryCategoryId);
    });

    // Both users own an Income / Salary row. On an account shared with the
    // importer, history carries the owner's row, which the importer's
    // category tree hides behind their own row at the same path.
    const shareOtherAccount = () =>
      pool.query(
        'INSERT INTO account_shares (account_id, user_id, level) VALUES ($1, $2, 2)',
        [otherAccountId, userId]
      );

    it('suggests the importer\'s own row for a path learned from a shared account', async () => {
      await shareOtherAccount();
      await seedIncome(otherUserId, otherAccountId, otherSalaryCategoryId);
      const result = await parseStatement(userId, eurAccountId, fixtureB64('lhv', 'statement.csv'));
      expect(result.rows[0].suggestedCategoryId).toBe(salaryCategoryId);
    });

    it('pools votes for the same path across users\' rows', async () => {
      // Salary via two rows (own + co-owner's) against one Bonus: 2/3 once
      // pooled by path, but a 1/1/1 split — no suggestion — if counted by id.
      const bonus = await pool.query(
        `INSERT INTO categories (user_id, name, parent_id) VALUES ($1, 'Bonus', 1) RETURNING id`,
        [userId]
      );
      await shareOtherAccount();
      await seedIncome(userId, eurAccountId, salaryCategoryId);
      await seedIncome(otherUserId, otherAccountId, otherSalaryCategoryId);
      await seedIncome(userId, eurAccountId, bonus.rows[0].id);
      const result = await parseStatement(userId, eurAccountId, fixtureB64('lhv', 'statement.csv'));
      expect(result.rows[0].suggestedCategoryId).toBe(salaryCategoryId);
    });

    it('returns null suggestions when there is no history at all', async () => {
      const result = await parseStatement(userId, eurAccountId, fixtureB64('lhv', 'statement.csv'));
      expect(result.rows.every(r => r.suggestedCategoryId === null && r.suggestionSource === null)).toBe(true);
    });
  });
});
