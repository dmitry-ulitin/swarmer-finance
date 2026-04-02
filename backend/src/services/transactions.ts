import * as transactionQueries from '../db/queries/transactions';
import * as categoryQueries from '../db/queries/categories';

export const getTransactions = async (
  userId: number,
  filters: transactionQueries.TransactionFilters
) => {
  return transactionQueries.getTransactionsByUserId(userId, filters);
};

export const createTransaction = async (
  userId: number,
  categoryId: number,
  amount: number,
  currency: string,
  date: string,
  description?: string
) => {
  const hasAccess = await categoryQueries.canUserAccessCategory(categoryId, userId);
  if (!hasAccess) {
    throw { statusCode: 403, message: 'Cannot use this category' };
  }

  const isLeaf = !(await categoryQueries.hasChildren(categoryId));
  if (!isLeaf) {
    throw { statusCode: 400, message: 'Must select a leaf category' };
  }

  return transactionQueries.createTransaction(userId, categoryId, amount, currency, date, description);
};

export const updateTransaction = async (
  id: number,
  userId: number,
  categoryId: number,
  amount: number,
  currency: string | undefined,
  date: string,
  description?: string
) => {
  const existing = await transactionQueries.getTransactionById(id, userId);
  if (!existing) {
    throw { statusCode: 404, message: 'Transaction not found' };
  }

  const hasAccess = await categoryQueries.canUserAccessCategory(categoryId, userId);
  if (!hasAccess) {
    throw { statusCode: 403, message: 'Cannot use this category' };
  }

  const isLeaf = !(await categoryQueries.hasChildren(categoryId));
  if (!isLeaf) {
    throw { statusCode: 400, message: 'Must select a leaf category' };
  }

  return transactionQueries.updateTransaction(id, userId, categoryId, amount, currency, date, description);
};

export const deleteTransaction = async (id: number, userId: number): Promise<void> => {
  const existing = await transactionQueries.getTransactionById(id, userId);
  if (!existing) {
    throw { statusCode: 404, message: 'Transaction not found' };
  }
  
  await transactionQueries.deleteTransaction(id, userId);
};
