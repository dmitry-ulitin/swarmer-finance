import { query, queryOne, execute } from '../index';
import { Transaction } from '../../types';

export interface TransactionFilters {
  from?: string;
  to?: string;
  category?: number;
  type?: 'income' | 'expense' | 'transfer';
  page?: number;
  limit?: number;
}

export interface CreateTransactionData {
  categoryId?: number;
  debitAccountId?: number;
  creditAccountId?: number;
  debit: number;
  credit: number;
  currency?: string;
  scale?: number;
  date: string;
  description?: string;
  payee?: string;
}

export interface UpdateTransactionData {
  categoryId?: number;
  debitAccountId?: number;
  creditAccountId?: number;
  debit?: number;
  credit?: number;
  currency?: string;
  date?: string;
  description?: string;
  payee?: string;
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

  if (filters.type === 'expense') {
    conditions.push('t.debit_account_id IS NOT NULL AND t.credit_account_id IS NULL');
  } else if (filters.type === 'income') {
    conditions.push('t.debit_account_id IS NULL AND t.credit_account_id IS NOT NULL');
  } else if (filters.type === 'transfer') {
    conditions.push('t.debit_account_id IS NOT NULL AND t.credit_account_id IS NOT NULL');
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
    `SELECT t.*,
            c.name as category_name, c.color as category_color,
            da.name as debit_account_name, da.currency as debit_account_currency,
            ca.name as credit_account_name, ca.currency as credit_account_currency
     FROM transactions t
     LEFT JOIN categories c ON t.category_id = c.id
     LEFT JOIN accounts da ON t.debit_account_id = da.id
     LEFT JOIN accounts ca ON t.credit_account_id = ca.id
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
  data: CreateTransactionData
): Promise<Transaction> => {
  const result = await query<Transaction>(
    `INSERT INTO transactions
       (user_id, category_id, debit_account_id, credit_account_id, debit, credit, currency, scale, date, description, payee)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) RETURNING *`,
    [
      userId,
      data.categoryId ?? null,
      data.debitAccountId ?? null,
      data.creditAccountId ?? null,
      data.debit,
      data.credit,
      data.currency ?? null,
      data.scale ?? 2,
      data.date,
      data.description || '',
      data.payee ?? null,
    ]
  );
  return result[0];
};

export const updateTransaction = async (
  id: number,
  userId: number,
  data: UpdateTransactionData
): Promise<Transaction | null> => {
  const result = await query<Transaction>(
    `UPDATE transactions
     SET category_id = COALESCE($1, category_id),
         debit_account_id = COALESCE($2, debit_account_id),
         credit_account_id = COALESCE($3, credit_account_id),
         debit = COALESCE($4, debit),
         credit = COALESCE($5, credit),
         currency = COALESCE($6, currency),
         date = COALESCE($7, date),
         description = COALESCE($8, description),
         payee = COALESCE($9, payee)
     WHERE id = $10 AND user_id = $11 RETURNING *`,
    [
      data.categoryId ?? null,
      data.debitAccountId ?? null,
      data.creditAccountId ?? null,
      data.debit ?? null,
      data.credit ?? null,
      data.currency ?? null,
      data.date ?? null,
      data.description ?? null,
      data.payee ?? null,
      id,
      userId,
    ]
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
