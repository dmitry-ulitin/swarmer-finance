import { query, queryOne, execute } from '../index';
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

export const getUserIdByEmail = async (email: string): Promise<number | null> => {
  const row = await queryOne<{ id: number }>(
    'SELECT id FROM users WHERE lower(email) = lower($1)',
    [email]
  );
  return row ? row.id : null;
};
