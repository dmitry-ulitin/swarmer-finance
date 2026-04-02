import { query, queryOne, execute } from '../index';
import { Transaction } from '../../types';

export interface TransactionFilters {
  from?: string;
  to?: string;
  category?: number;
  type?: 'income' | 'expense';
  page?: number;
  limit?: number;
}

export const getTransactionsByUserId = async (
  userId: number,
  filters: TransactionFilters
): Promise<{ transactions: Transaction[]; total: number }> => {
  const conditions: string[] = ['t.user_id = $1'];
  const params: unknown[] = [userId];
  let paramIndex = 2;
  
  if (filters.from) {
    conditions.push(`t.date >= $${paramIndex++}`);
    params.push(filters.from);
  }
  
  if (filters.to) {
    conditions.push(`t.date <= $${paramIndex++}`);
    params.push(filters.to);
  }
  
  if (filters.category) {
    conditions.push(`t.category_id = $${paramIndex++}`);
    params.push(filters.category);
  }
  
  const whereClause = conditions.join(' AND ');
  const page = filters.page || 1;
  const limit = filters.limit || 20;
  const offset = (page - 1) * limit;
  
  const countResult = await query<{ total: string }>(
    `SELECT COUNT(*) as total FROM transactions t WHERE ${whereClause}`,
    params
  );
  
  const transactions = await query<Transaction>(
    `SELECT t.*, c.name as category_name, c.color as category_color
     FROM transactions t
     JOIN categories c ON t.category_id = c.id
     WHERE ${whereClause}
     ORDER BY t.date DESC, t.created_at DESC
     LIMIT $${paramIndex++} OFFSET $${paramIndex}`,
    [...params, limit, offset]
  );
  
  return {
    transactions,
    total: parseInt(countResult[0]?.total || '0', 10),
  };
};

export const getTransactionById = async (
  id: number,
  userId: number
): Promise<Transaction | null> => {
  return queryOne<Transaction>(
    'SELECT * FROM transactions WHERE id = $1 AND user_id = $2',
    [id, userId]
  );
};

export const createTransaction = async (
  userId: number,
  categoryId: number,
  amount: number,
  currency: string,
  date: string,
  description?: string
): Promise<Transaction> => {
  const result = await query<Transaction>(
    `INSERT INTO transactions (user_id, category_id, amount, date, currency, description)
     VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
    [userId, categoryId, amount, date, currency, description || '']
  );
  return result[0];
};

export const updateTransaction = async (
  id: number,
  userId: number,
  categoryId: number,
  amount: number,
  currency: string | undefined,
  date: string,
  description?: string
): Promise<Transaction | null> => {
  const result = await query<Transaction>(
    `UPDATE transactions
     SET category_id = $1, amount = $2, date = $3, description = $4, currency = COALESCE($5, currency)
     WHERE id = $6 AND user_id = $7 RETURNING *`,
    [categoryId, amount, date, description || '', currency ?? null, id, userId]
  );
  return result[0] || null;
};

export const deleteTransaction = async (
  id: number,
  userId: number
): Promise<boolean> => {
  const count = await execute(
    'DELETE FROM transactions WHERE id = $1 AND user_id = $2',
    [id, userId]
  );
  return count > 0;
};
