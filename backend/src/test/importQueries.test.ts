import { pool } from '../db';
import {
  findExistingImportHashes,
  createImportedTransactions,
} from '../db/queries/transactions';

describe('import queries', () => {
  let userId: number;
  let accountId: number;

  beforeAll(async () => {
    const u = await pool.query(
      `INSERT INTO users (email, password_hash, name, currency)
       VALUES ($1, 'x', 'Query Test', 'EUR') RETURNING id`,
      [`q${Date.now()}@example.com`]
    );
    userId = u.rows[0].id;
    const a = await pool.query(
      `INSERT INTO accounts (user_id, name, currency, start_balance)
       VALUES ($1, 'Q Account', 'EUR', 0) RETURNING id`,
      [userId]
    );
    accountId = a.rows[0].id;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM transactions WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM accounts WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM categories WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM transactions WHERE user_id = $1', [userId]);
  });

  const row = (hash: string, amount = -1000, payee: string | null = null) => ({
    categoryId: 4,
    debitAccountId: amount < 0 ? accountId : null,
    creditAccountId: amount < 0 ? null : accountId,
    debit: Math.abs(amount),
    credit: Math.abs(amount),
    date: '2026-07-01',
    description: 'imported',
    payee,
    importHash: hash,
  });

  it('inserts rows and reports the count', async () => {
    const n = await createImportedTransactions(userId, [row('h1'), row('h2')]);
    expect(n).toBe(2);
  });

  it('skips rows whose hash already exists', async () => {
    await createImportedTransactions(userId, [row('h1')]);
    const n = await createImportedTransactions(userId, [row('h1'), row('h2')]);
    expect(n).toBe(1);
  });

  it('finds which hashes are already present', async () => {
    await createImportedTransactions(userId, [row('h1'), row('h2')]);
    const found = await findExistingImportHashes(accountId, ['h1', 'h3']);
    expect(found).toEqual(['h1']);
  });

  it('returns nothing for an empty hash list', async () => {
    expect(await findExistingImportHashes(accountId, [])).toEqual([]);
  });

  it('round-trips payee on inserted rows', async () => {
    await createImportedTransactions(userId, [row('h1', -1000, 'ACME Corp')]);
    const result = await pool.query(
      'SELECT payee FROM transactions WHERE user_id = $1 AND import_hash = $2',
      [userId, 'h1']
    );
    expect(result.rows[0].payee).toBe('ACME Corp');
  });
});
