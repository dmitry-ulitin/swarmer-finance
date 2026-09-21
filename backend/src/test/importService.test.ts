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
    await pool.query('DELETE FROM transactions WHERE user_id = $1', [userId]);
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
});
