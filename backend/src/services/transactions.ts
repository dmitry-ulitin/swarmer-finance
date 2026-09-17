import * as transactionQueries from '../db/queries/transactions';
import * as categoryQueries from '../db/queries/categories';
import * as accountQueries from '../db/queries/accounts';
import { toDecimal, toCents } from './currency';
import { Account, TransactionDTO } from '../types';
import { LEVEL, getAccessibleAccountIds, requireLevelOnAll } from './access';

const UNCATEGORIZED_INCOME_CATEGORY_ID = 3;
const UNCATEGORIZED_EXPENSE_CATEGORY_ID = 4;

type CreateInput = {
  categoryId?: number;
  debitAccountId?: number;
  creditAccountId?: number;
  debit: number;
  credit: number;
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
  const account = await accountQueries.getAccountById(accountId);
  if (!account || account.deleted) {
    throw { statusCode: 403, message: `Cannot use this ${label} account` };
  }
  await requireLevelOnAll([accountId], userId, LEVEL.WRITE);
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
    const debitAccount = await loadAccount(input.debitAccountId!, userId, 'debit');
    const creditAccount = await loadAccount(input.creditAccountId!, userId, 'credit');
    input.debit = toCents(input.debit, debitAccount.scale);
    input.credit = toCents(input.credit, creditAccount.scale);
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
    const debitAccount = await loadAccount(input.debitAccountId!, userId, 'debit');
    input.debit = toCents(input.debit, debitAccount.scale);
    input.credit = toCents(input.credit, debitAccount.scale);
    if (input.debit !== input.credit) {
      throw {
        statusCode: 400,
        message: `Expenses require debit to equal credit (account and transaction are ${debitAccount.currency})`,
      };
    }
    if (input.categoryId == null) {
      input.categoryId = UNCATEGORIZED_EXPENSE_CATEGORY_ID;
    }
    await validateCategory(input.categoryId, userId);
  } else {
    // Income
    const creditAccount = await loadAccount(input.creditAccountId!, userId, 'credit');
    input.debit = toCents(input.debit, creditAccount.scale);
    input.credit = toCents(input.credit, creditAccount.scale);
    if (input.debit !== input.credit) {
      throw {
        statusCode: 400,
        message: `Income requires debit to equal credit (account and transaction are ${creditAccount.currency})`,
      };
    }
    if (input.categoryId == null) {
      input.categoryId = UNCATEGORIZED_INCOME_CATEGORY_ID;
    }
    await validateCategory(input.categoryId, userId);
  }
}

function toDecimalTransactionDTO(t: TransactionDTO): TransactionDTO {
  const debitScale = t.debit_account?.scale ?? t.credit_account?.scale ?? 2;
  const creditScale = t.credit_account?.scale ?? t.debit_account?.scale ?? 2;
  return {
    ...t,
    debit: toDecimal(t.debit, debitScale),
    credit: toDecimal(t.credit, creditScale),
    debit_account: t.debit_account && t.debit_account.balance != null
      ? { ...t.debit_account, balance: toDecimal(t.debit_account.balance, t.debit_account.scale) }
      : t.debit_account,
    credit_account: t.credit_account && t.credit_account.balance != null
      ? { ...t.credit_account, balance: toDecimal(t.credit_account.balance, t.credit_account.scale) }
      : t.credit_account,
  };
}

export const getTransactions = async (
  userId: number,
  filters: transactionQueries.TransactionFilters
) => {
  const accessibleIds = await getAccessibleAccountIds(userId);
  // A supplied `account` filter is intersected with what the user may see,
  // never trusted on its own.
  const accountIds = filters.account?.length
    ? filters.account.filter(id => accessibleIds.includes(id))
    : accessibleIds;

  const transactions = await transactionQueries.getTransactions(accountIds, { ...filters, account: undefined });
  const sequential = !filters.details && !filters.category?.length && !filters.type;
  const result = sequential && transactions.length > 0
    ? await attachRunningBalances(transactions, accessibleIds)
    : transactions;
  return result.map(toDecimalTransactionDTO);
};

async function attachRunningBalances(
  transactions: import('../types').TransactionDTO[],
  accessibleIds: number[]
) {
  // A cross-boundary transfer's counterparty account may appear on the DTO
  // (its name is not secret) but its balance must not be computed or
  // returned unless the caller can also reach that account.
  const accountIds = [...new Set(
    transactions.flatMap(t => [t.debit_account?.id, t.credit_account?.id].filter((id): id is number => id != null))
  )].filter(id => accessibleIds.includes(id));

  // transactions are ordered newest-first (date DESC, created_at DESC, id
  // DESC); anchor the seed balance strictly before the oldest transaction
  // on this page, then walk forward (oldest to newest) applying each
  // transaction's own effect. Seeding from a specific transaction's cursor
  // — rather than a bare date — avoids double-counting same-date
  // transactions that fall on a different page.
  const last = transactions[transactions.length - 1];
  const lastDate = new Date(last.date);
  const dateStr = `${lastDate.getFullYear()}-${String(lastDate.getMonth() + 1).padStart(2, '0')}-${String(lastDate.getDate()).padStart(2, '0')}`;
  const balanceRows = await transactionQueries.getBalancesAt(accountIds, dateStr, last.created_at, last.id);
  const balanceMap = new Map(balanceRows.map(r => [r.id, r.balance]));

  const withBalances = [];
  for (let i = transactions.length - 1; i >= 0; i--) {
    const t = transactions[i];
    // Only accumulate for accounts seeded above (i.e. accessible to the
    // caller); an excluded account must never gain an entry via `?? 0`,
    // which would fabricate a balance from this page alone.
    if (t.debit_account && balanceMap.has(t.debit_account.id)) {
      balanceMap.set(t.debit_account.id, balanceMap.get(t.debit_account.id)! - Number(t.debit));
    }
    if (t.credit_account && balanceMap.has(t.credit_account.id)) {
      balanceMap.set(t.credit_account.id, balanceMap.get(t.credit_account.id)! + Number(t.credit));
    }
    withBalances[i] = {
      ...t,
      debit_account: t.debit_account ? { ...t.debit_account, balance: balanceMap.get(t.debit_account.id) } : null,
      credit_account: t.credit_account ? { ...t.credit_account, balance: balanceMap.get(t.credit_account.id) } : null,
    };
  }
  return withBalances;
}

export const createTransaction = async (userId: number, input: CreateInput) => {
  await validateTransactionInput(input, userId);
  const transaction = await transactionQueries.createTransaction(userId, input);
  return toDecimalTransactionDTO(transaction);
};

export const updateTransaction = async (id: number, userId: number, input: UpdateInput) => {
  const existing = await transactionQueries.getTransactionById(id);
  if (!existing) {
    throw { statusCode: 404, message: 'Transaction not found' };
  }

  // Write access on the accounts the transaction touches TODAY. The accounts
  // it will touch after the update are checked by validateTransactionInput ->
  // loadAccount below. Both matter: without the first check a transaction
  // could be moved off an account the user cannot write to.
  await requireLevelOnAll(
    [existing.debit_account_id, existing.credit_account_id],
    userId,
    LEVEL.WRITE
  );

  // existing.debit/credit are stored in cents; input.debit/credit (when
  // provided) arrive as decimal from the API. Convert existing to decimal
  // using its own accounts' scales so the merged object is consistently
  // decimal before re-validation converts it back to cents.
  const existingDebitAccount = existing.debit_account_id != null
    ? await accountQueries.getAccountById(existing.debit_account_id)
    : null;
  const existingCreditAccount = existing.credit_account_id != null
    ? await accountQueries.getAccountById(existing.credit_account_id)
    : null;
  const existingScale = existingDebitAccount?.scale ?? existingCreditAccount?.scale ?? 2;

  // Merge input with existing values to re-validate the full resulting state.
  // null in input means "clear this field"; undefined means "keep existing".
  const merged: CreateInput = {
    categoryId: input.categoryId !== undefined ? (input.categoryId ?? undefined) : (existing.category_id ?? undefined),
    debitAccountId: input.debitAccountId !== undefined ? (input.debitAccountId ?? undefined) : (existing.debit_account_id ?? undefined),
    creditAccountId: input.creditAccountId !== undefined ? (input.creditAccountId ?? undefined) : (existing.credit_account_id ?? undefined),
    debit: input.debit ?? toDecimal(existing.debit, existingScale),
    credit: input.credit ?? toDecimal(existing.credit, existingScale),
    date: input.date ?? formatDate(existing.date),
    description: input.description !== undefined ? (input.description ?? undefined) : existing.description,
    payee: input.payee !== undefined ? (input.payee ?? undefined) : (existing.payee ?? undefined),
  };

  await validateTransactionInput(merged, userId);
  const transaction = await transactionQueries.updateTransaction(id, merged);
  return transaction ? toDecimalTransactionDTO(transaction) : transaction;
};

export const deleteTransaction = async (id: number, userId: number): Promise<void> => {
  const existing = await transactionQueries.getTransactionById(id);
  if (!existing) {
    throw { statusCode: 404, message: 'Transaction not found' };
  }
  await requireLevelOnAll(
    [existing.debit_account_id, existing.credit_account_id],
    userId,
    LEVEL.WRITE
  );
  await transactionQueries.deleteTransaction(id);
};

export const getAccountBalances = async (
  accountIds: number[]
): Promise<transactionQueries.AccountBalance[]> => {
  return transactionQueries.getAccountBalances(accountIds);
};
