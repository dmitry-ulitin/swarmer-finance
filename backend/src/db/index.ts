import { Pool } from 'pg';
import dotenv from 'dotenv';

dotenv.config();

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

export async function query<T>(text: string, params?: unknown[]): Promise<T[]> {
  const result = await pool.query(text, params);
  return result.rows as T[];
}

export async function queryOne<T>(text: string, params?: unknown[]): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] || null;
}

export async function execute(text: string, params?: unknown[]): Promise<number> {
  const result = await pool.query(text, params);
  return result.rowCount || 0;
}

export interface Tx {
  query<T>(text: string, params?: unknown[]): Promise<T[]>;
  queryOne<T>(text: string, params?: unknown[]): Promise<T | null>;
}

/**
 * Run `fn` inside a single transaction, rolling back if it throws.
 *
 * Used where a multi-step write must not leave a partial result behind —
 * copying a category path creates one row per missing ancestor.
 */
export async function withTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const tx: Tx = {
      async query<R>(text: string, params?: unknown[]): Promise<R[]> {
        const result = await client.query(text, params);
        return result.rows as R[];
      },
      async queryOne<R>(text: string, params?: unknown[]): Promise<R | null> {
        const result = await client.query(text, params);
        return (result.rows[0] as R) || null;
      },
    };
    const value = await fn(tx);
    await client.query('COMMIT');
    return value;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}
