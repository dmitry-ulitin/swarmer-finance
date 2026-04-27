import { query, queryOne, execute } from '../index';
import { User } from '../../types';

export const getUserByEmail = async (email: string): Promise<User | null> => {
  return queryOne<User>('SELECT * FROM users WHERE email = $1', [email]);
};

export const getUserById = async (id: number): Promise<User | null> => {
  return queryOne<User>('SELECT id, email, name, currency, created_at FROM users WHERE id = $1', [id]);
};

export const createUser = async (email: string, passwordHash: string, name: string, currency: string): Promise<User> => {
  const result = await query<User>(
    'INSERT INTO users (email, password_hash, name, currency) VALUES ($1, $2, $3, $4) RETURNING *',
    [email, passwordHash, name, currency]
  );
  return result[0];
};
