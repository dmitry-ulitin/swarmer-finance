import * as transactionQueries from '../db/queries/transactions';
import * as categoryQueries from '../db/queries/categories';
import * as accountQueries from '../db/queries/accounts';

type CreateInput = {
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
};

type UpdateInput = Partial<CreateInput>;

async function validateAccountOwnership(accountId: number, userId: number, label: string): Promise<void> {
  const account = await accountQueries.getAccountById(accountId, userId);
  if (!account) {
    throw { statusCode: 403, message: `Cannot use this ${label} account` };
  }
}

async function validateCategory(categoryId: number, userId: number): Promise<void> {
  const hasAccess = await categoryQueries.canUserAccessCategory(categoryId, userId);
  if (!hasAccess) {
    throw { statusCode: 403, message: 'Cannot use this category' };
  }
  const isLeaf = !(await categoryQueries.hasChildren(categoryId));
  if (!isLeaf) {
    throw { statusCode: 400, message: 'Must select a leaf category' };
  }
}

async function validateTransactionInput(input: CreateInput, userId: number): Promise<void> {
  const hasDebit = input.debitAccountId != null;
  const hasCredit = input.creditAccountId != null;

  if (!hasDebit && !hasCredit) {
    throw { statusCode: 400, message: 'Must specify at least one account' };
  }

  if (hasDebit && hasCredit) {
    // Transfer
    if (input.categoryId != null) {
      throw { statusCode: 400, message: 'Transfers must not have a category' };
    }
    if (input.currency != null) {
      throw { statusCode: 400, message: 'Transfers must not have a currency' };
    }
    if (input.scale != null) {
      throw { statusCode: 400, message: 'Transfers must not have a scale' };
    }
    await validateAccountOwnership(input.debitAccountId!, userId, 'debit');
    await validateAccountOwnership(input.creditAccountId!, userId, 'credit');
  } else if (hasDebit) {
    // Expense
    if (input.categoryId == null) {
      throw { statusCode: 400, message: 'Expenses must have a category' };
    }
    if (input.currency == null) {
      throw { statusCode: 400, message: 'Expenses must have a currency (credit side)' };
    }
    if (input.scale == null) {
      throw { statusCode: 400, message: 'Expenses must have a scale (credit side)' };
    }
    await validateAccountOwnership(input.debitAccountId!, userId, 'debit');
    await validateCategory(input.categoryId, userId);
  } else {
    // Income
    if (input.categoryId == null) {
      throw { statusCode: 400, message: 'Income transactions must have a category' };
    }
    if (input.currency == null) {
      throw { statusCode: 400, message: 'Income transactions must have a currency (debit side)' };
    }
    if (input.scale == null) {
      throw { statusCode: 400, message: 'Income transactions must have a scale (debit side)' };
    }
    await validateAccountOwnership(input.creditAccountId!, userId, 'credit');
    await validateCategory(input.categoryId, userId);
  }
}

export const getTransactions = async (
  userId: number,
  filters: transactionQueries.TransactionFilters
) => {
  return transactionQueries.getTransactionsByUserId(userId, filters);
};

export const createTransaction = async (userId: number, input: CreateInput) => {
  await validateTransactionInput(input, userId);
  return transactionQueries.createTransaction(userId, input);
};

export const updateTransaction = async (id: number, userId: number, input: UpdateInput) => {
  const existing = await transactionQueries.getTransactionById(id, userId);
  if (!existing) {
    throw { statusCode: 404, message: 'Transaction not found' };
  }

  // Merge input with existing values to re-validate the full resulting state
  const merged: CreateInput = {
    categoryId: input.categoryId !== undefined ? input.categoryId : (existing.category_id ?? undefined),
    debitAccountId: input.debitAccountId !== undefined ? input.debitAccountId : (existing.debit_account_id ?? undefined),
    creditAccountId: input.creditAccountId !== undefined ? input.creditAccountId : (existing.credit_account_id ?? undefined),
    debit: input.debit ?? existing.debit,
    credit: input.credit ?? existing.credit,
    currency: input.currency !== undefined ? input.currency : (existing.currency ?? undefined),
    scale: input.scale !== undefined ? input.scale : (existing.scale ?? 2),
    date: input.date ?? existing.date.toString(),
    description: input.description ?? existing.description,
    payee: input.payee !== undefined ? input.payee : (existing.payee ?? undefined),
  };

  await validateTransactionInput(merged, userId);
  return transactionQueries.updateTransaction(id, userId, input);
};

export const deleteTransaction = async (id: number, userId: number): Promise<void> => {
  const existing = await transactionQueries.getTransactionById(id, userId);
  if (!existing) {
    throw { statusCode: 404, message: 'Transaction not found' };
  }
  await transactionQueries.deleteTransaction(id, userId);
};
