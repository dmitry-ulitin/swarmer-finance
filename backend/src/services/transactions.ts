import * as transactionQueries from '../db/queries/transactions';
import * as categoryQueries from '../db/queries/categories';
import * as accountQueries from '../db/queries/accounts';
import { Account } from '../types';

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

type UpdateInput = {
  categoryId?: number | null;
  debitAccountId?: number | null;
  creditAccountId?: number | null;
  debit?: number;
  credit?: number;
  currency?: string | null;
  scale?: number | null;
  date?: string;
  description?: string | null;
  payee?: string | null;
};

function formatDate(date: string | Date): string {
  if (typeof date === 'string') return date;
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

async function loadAccount(accountId: number, userId: number, label: string): Promise<Account> {
  const account = await accountQueries.getAccountById(accountId, userId);
  if (!account) {
    throw { statusCode: 403, message: `Cannot use this ${label} account` };
  }
  return account;
}

async function validateCategory(categoryId: number, userId: number): Promise<void> {
  const hasAccess = await categoryQueries.canUserAccessCategory(categoryId, userId);
  if (!hasAccess) {
    throw { statusCode: 403, message: 'Cannot use this category' };
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
    const debitAccount = await loadAccount(input.debitAccountId!, userId, 'debit');
    const creditAccount = await loadAccount(input.creditAccountId!, userId, 'credit');
    // When both accounts share a currency, debit and credit must be equal —
    // otherwise value silently disappears or appears between the two sides.
    // Cross-currency transfers allow debit != credit (FX conversion / fee).
    if (debitAccount.currency === creditAccount.currency && input.debit !== input.credit) {
      throw {
        statusCode: 400,
        message: `Same-currency transfers require debit to equal credit (both accounts are ${debitAccount.currency})`,
      };
    }
  } else if (hasDebit) {
    // Expense
    if (input.currency == null) {
      throw { statusCode: 400, message: 'Expense transactions must have a currency' };
    }
    const debitAccount = await loadAccount(input.debitAccountId!, userId, 'debit');
    // Same-currency rule: when the transaction currency matches the
    // account currency, debit must equal credit (otherwise value silently
    // appears or disappears between sides). Cross-currency expenses are
    // allowed and may have debit != credit (FX conversion / fee).
    if (debitAccount.currency === input.currency && input.debit !== input.credit) {
      throw {
        statusCode: 400,
        message: `Same-currency expenses require debit to equal credit (account and transaction are ${debitAccount.currency})`,
      };
    }
    if (input.categoryId != null) {
      await validateCategory(input.categoryId, userId);
    }
  } else {
    // Income
    if (input.currency == null) {
      throw { statusCode: 400, message: 'Income transactions must have a currency' };
    }
    const creditAccount = await loadAccount(input.creditAccountId!, userId, 'credit');
    // Same rule as expense — see comment above.
    if (creditAccount.currency === input.currency && input.debit !== input.credit) {
      throw {
        statusCode: 400,
        message: `Same-currency income requires debit to equal credit (account and transaction are ${creditAccount.currency})`,
      };
    }
    if (input.categoryId != null) {
      await validateCategory(input.categoryId, userId);
    }
  }
}

export const getTransactions = async (
  userId: number,
  filters: transactionQueries.TransactionFilters
) => {
  const transactions = await transactionQueries.getTransactionsByUserId(userId, filters);
  const sequential = !filters.details && !filters.category?.length && !filters.type;
  if (sequential && transactions.length > 0) {
    return attachRunningBalances(userId, transactions);
  }
  return transactions;
};

async function attachRunningBalances(
  userId: number,
  transactions: import('../types').TransactionDTO[]
) {
  const accountIds = [...new Set(
    transactions.flatMap(t => [t.debit_account?.id, t.credit_account?.id].filter((id): id is number => id != null))
  )];

  const first = transactions[0];
  const d = new Date(first.date);
  const dateStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const balanceRows = await transactionQueries.getBalancesAt(userId, accountIds, dateStr);
  const balanceMap = new Map(balanceRows.map(r => [r.id, r.balance]));

  return transactions.map(t => {
    const dto = {
      ...t,
      debit_account: t.debit_account ? { ...t.debit_account, balance: balanceMap.get(t.debit_account.id) } : null,
      credit_account: t.credit_account ? { ...t.credit_account, balance: balanceMap.get(t.credit_account.id) } : null,
    };
    if (t.debit_account) balanceMap.set(t.debit_account.id, (balanceMap.get(t.debit_account.id) ?? 0) + Number(t.debit));
    if (t.credit_account) balanceMap.set(t.credit_account.id, (balanceMap.get(t.credit_account.id) ?? 0) - Number(t.credit));
    return dto;
  });
}

export const createTransaction = async (userId: number, input: CreateInput) => {
  await validateTransactionInput(input, userId);
  return transactionQueries.createTransaction(userId, input);
};

export const updateTransaction = async (id: number, userId: number, input: UpdateInput) => {
  const existing = await transactionQueries.getTransactionById(id, userId);
  if (!existing) {
    throw { statusCode: 404, message: 'Transaction not found' };
  }

  // Merge input with existing values to re-validate the full resulting state.
  // null in input means "clear this field"; undefined means "keep existing".
  const merged: CreateInput = {
    categoryId: input.categoryId !== undefined ? (input.categoryId ?? undefined) : (existing.category_id ?? undefined),
    debitAccountId: input.debitAccountId !== undefined ? (input.debitAccountId ?? undefined) : (existing.debit_account_id ?? undefined),
    creditAccountId: input.creditAccountId !== undefined ? (input.creditAccountId ?? undefined) : (existing.credit_account_id ?? undefined),
    debit: input.debit ?? existing.debit,
    credit: input.credit ?? existing.credit,
    currency: input.currency !== undefined ? (input.currency ?? undefined) : (existing.currency ?? undefined),
    scale: input.scale !== undefined ? (input.scale ?? undefined) : (existing.scale ?? 2),
    date: input.date ?? formatDate(existing.date),
    description: input.description !== undefined ? (input.description ?? undefined) : existing.description,
    payee: input.payee !== undefined ? (input.payee ?? undefined) : (existing.payee ?? undefined),
  };

  await validateTransactionInput(merged, userId);
  return transactionQueries.updateTransaction(id, userId, merged);
};

export const deleteTransaction = async (id: number, userId: number): Promise<void> => {
  const existing = await transactionQueries.getTransactionById(id, userId);
  if (!existing) {
    throw { statusCode: 404, message: 'Transaction not found' };
  }
  await transactionQueries.deleteTransaction(id, userId);
};

export const getAccountBalances = async (
  userId: number,
  accountIds: number[]
): Promise<transactionQueries.AccountBalance[]> => {
  return transactionQueries.getAccountBalances(userId, accountIds);
};
