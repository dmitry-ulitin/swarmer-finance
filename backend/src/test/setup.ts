import { pool } from '../db';
import dotenv from 'dotenv';

dotenv.config();

beforeAll(async () => {
  await pool.query('DELETE FROM account_valuations');
  await pool.query('DELETE FROM transactions');
  await pool.query('DELETE FROM categories WHERE user_id IS NOT NULL');
  await pool.query('DELETE FROM users');
});

afterAll(async () => {
  await pool.end();
});
