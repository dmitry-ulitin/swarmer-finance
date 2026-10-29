import { query, queryOne, execute, pooled, Tx } from '../index';
import { User } from '../../types';

export const getUserByEmail = async (email: string): Promise<User | null> => {
  return queryOne<User>('SELECT * FROM users WHERE email = $1', [email]);
};

export const getUserById = async (id: number): Promise<User | null> => {
  return queryOne<User>(
    'SELECT id, email, name, currency, currency_scale, created_at FROM users WHERE id = $1',
    [id]
  );
};

export const createUser = async (
  email: string,
  passwordHash: string,
  name: string,
  currency: string,
  currencyScale: number
): Promise<User> => {
  const result = await query<User>(
    'INSERT INTO users (email, password_hash, name, currency, currency_scale) VALUES ($1, $2, $3, $4, $5) RETURNING *',
    [email, passwordHash, name, currency, currencyScale]
  );
  return result[0];
};

export const updateProfile = async (
  id: number,
  name: string,
  currency: string,
  currencyScale: number
): Promise<User | null> => {
  return queryOne<User>(
    `UPDATE users SET name = $2, currency = $3, currency_scale = $4 WHERE id = $1
     RETURNING id, email, name, currency, currency_scale, created_at`,
    [id, name, currency, currencyScale]
  );
};

export const getPasswordHashById = async (id: number): Promise<string | null> => {
  const row = await queryOne<{ password_hash: string }>(
    'SELECT password_hash FROM users WHERE id = $1',
    [id]
  );
  return row ? row.password_hash : null;
};

export const updatePasswordHash = async (id: number, passwordHash: string): Promise<void> => {
  await execute('UPDATE users SET password_hash = $2 WHERE id = $1', [id, passwordHash]);
};

export const getUserIdByEmail = async (email: string, tx: Tx = pooled): Promise<number | null> => {
  const row = await tx.queryOne<{ id: number }>(
    'SELECT id FROM users WHERE lower(email) = lower($1)',
    [email]
  );
  return row ? row.id : null;
};
