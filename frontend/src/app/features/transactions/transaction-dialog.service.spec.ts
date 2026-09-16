import { describe, it, expect } from 'vitest';
import { buildCreateDefaults } from './transaction-dialog.service';
import type { Transaction, TransactionAccount } from '../../models/transaction';
import type { Account } from '../../models/account';

function makeTxAccount(id: number, name: string): TransactionAccount {
  return { id, name, currency: 'USD', scale: 2 };
}

function makeAccount(id: number, name: string): Account {
  return { id, user_id: 1, name, currency: 'USD', scale: 2, balance: 0, user_balance: 0, start_balance: 0, deleted: false, created_at: '', type: 'cash', settings: {} };
}

function makeTransaction(overrides: Partial<Transaction>): Transaction {
  return {
    id: 1,
    user_id: 1,
    category: null,
    debit_account: null,
    credit_account: null,
    debit: 100,
    credit: 100,
    currency: 'USD',
    scale: 2,
    date: '2026-09-01',
    description: 'prior',
    payee: 'someone',
    created_at: '2026-09-01T00:00:00Z',
    ...overrides,
  };
}

describe('buildCreateDefaults', () => {
  it('defaults to Expense (debit_account set, credit_account null) even when the last transaction was a Transfer', () => {
    const lastTransfer = makeTransaction({
      debit_account: makeTxAccount(1, 'Euro Wallet'),
      credit_account: makeTxAccount(2, 'Wallet USD'),
    });

    const result = buildCreateDefaults(lastTransfer, undefined, '2026-09-14');

    expect(result?.debit_account).toEqual(makeTxAccount(1, 'Euro Wallet'));
    expect(result?.credit_account).toBeNull();
  });

  it('defaults to Expense even when the last transaction was Income', () => {
    const lastIncome = makeTransaction({
      debit_account: null,
      credit_account: makeTxAccount(3, 'Savings'),
    });

    const result = buildCreateDefaults(lastIncome, undefined, '2026-09-14');

    expect(result?.debit_account).toEqual(makeTxAccount(3, 'Savings'));
    expect(result?.credit_account).toBeNull();
  });

  it('carries over the debit_account and clears amounts/description when last transaction was Expense', () => {
    const lastExpense = makeTransaction({
      debit_account: makeTxAccount(4, 'Wallet'),
      credit_account: null,
      description: 'Groceries',
      payee: 'Store',
    });

    const result = buildCreateDefaults(lastExpense, undefined, '2026-09-14');

    expect(result?.debit_account).toEqual(makeTxAccount(4, 'Wallet'));
    expect(result?.credit_account).toBeNull();
    expect(result?.description).toBe('');
    expect(result?.payee).toBe('');
    expect(result?.debit).toBeUndefined();
    expect(result?.credit).toBeUndefined();
    expect(result?.date).toBe('2026-09-14');
  });

  it('falls back to the preferred account as Expense when there is no last transaction', () => {
    const account = makeAccount(5, 'Wallet USD');

    const result = buildCreateDefaults(undefined, account, '2026-09-14');

    expect(result?.debit_account).toEqual(account);
    expect(result?.credit_account).toBeUndefined();
    expect(result?.currency).toBe('USD');
    expect(result?.date).toBe('2026-09-14');
  });

  it('returns null when there is no last transaction and no preferred account', () => {
    expect(buildCreateDefaults(undefined, undefined, '2026-09-14')).toBeNull();
  });
});
