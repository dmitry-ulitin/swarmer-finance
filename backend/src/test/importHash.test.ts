import { pool } from '../db';

describe('import_hash schema', () => {
  let userId: number;
  let accountId: number;

  beforeAll(async () => {
    const u = await pool.query(
      `INSERT INTO users (email, password_hash, name, currency)
       VALUES ($1, 'x', 'Hash Test', 'EUR') RETURNING id`,
      [`hash${Date.now()}@example.com`]
    );
    userId = u.rows[0].id;
    const a = await pool.query(
      `INSERT INTO accounts (user_id, name, currency, start_balance)
       VALUES ($1, 'Hash Account', 'EUR', 0) RETURNING id`,
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

  const insert = (hash: string | null) =>
    pool.query(
      `INSERT INTO transactions
         (user_id, category_id, debit_account_id, debit, credit, date, description, import_hash)
       VALUES ($1, 4, $2, 1000, 1000, '2026-07-01', 'x', $3)`,
      [userId, accountId, hash]
    );

  it('rejects a duplicate hash on the same account', async () => {
    await insert('hash-a');
    await expect(insert('hash-a')).rejects.toThrow();
  });

  it('allows the same hash on a different account', async () => {
    const other = await pool.query(
      `INSERT INTO accounts (user_id, name, currency, start_balance)
       VALUES ($1, 'Other', 'EUR', 0) RETURNING id`,
      [userId]
    );
    await expect(
      pool.query(
        `INSERT INTO transactions
           (user_id, category_id, debit_account_id, debit, credit, date, description, import_hash)
         VALUES ($1, 4, $2, 1000, 1000, '2026-07-01', 'x', 'hash-a')`,
        [userId, other.rows[0].id]
      )
    ).resolves.toBeDefined();
  });

  it('allows many NULL hashes — hand-entered rows are unconstrained', async () => {
    await insert(null);
    await expect(insert(null)).resolves.toBeDefined();
  });
});
