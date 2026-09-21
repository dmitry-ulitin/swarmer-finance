import * as fs from 'fs';
import * as path from 'path';
import { pool } from '../db';
import { parseStatement, reconcile } from '../services/import';

const fixtureB64 = (...p: string[]) =>
  fs.readFileSync(path.join(__dirname, 'fixtures', 'banks', ...p)).toString('base64');

describe('reconcile', () => {
  let userId: number;
  let otherUserId: number;
  let accountId: number;

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
    const a = await pool.query(
      `INSERT INTO accounts (user_id, name, currency, start_balance)
       VALUES ($1, 'Rec Account', 'EUR', 0) RETURNING id`,
      [userId]
    );
    accountId = a.rows[0].id;
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
});
