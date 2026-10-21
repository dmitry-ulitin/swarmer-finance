import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { TuiDialogService } from '@taiga-ui/core';
import { buildCreateDefaults, TransactionDialogService } from './transaction-dialog.service';
import { TransactionsState } from '../../core/transactions.state';
import { AccountsState } from '../../core/accounts.state';
import { NotificationService } from '../../core/notification.service';
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
    txid: null,
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

  it('does not carry over the txid of a synced transfer', () => {
    const lastTransfer = makeTransaction({
      debit_account: makeTxAccount(1, 'Cash'),
      credit_account: makeTxAccount(2, 'Wallet'),
      txid: 'abc123',
    });

    expect(buildCreateDefaults(lastTransfer, undefined, '2026-09-14')?.txid).toBeNull();
  });

  it('returns null when there is no last transaction and no preferred account', () => {
    expect(buildCreateDefaults(undefined, undefined, '2026-09-14')).toBeNull();
  });
});

describe('TransactionDialogService.openCreate', () => {
  const cash = makeAccount(1, 'Cash');
  const shared = makeAccount(2, 'Shared read-only');
  let open: ReturnType<typeof vi.fn>;
  let showError: ReturnType<typeof vi.fn>;
  let transactions: ReturnType<typeof signal<Transaction[]>>;
  let transferTargets: ReturnType<typeof signal<Account[]>>;
  let service: TransactionDialogService;

  const prefill = () => open.mock.lastCall![1].data as Partial<Transaction>;

  beforeEach(() => {
    open = vi.fn(() => of(null));
    showError = vi.fn();
    transactions = signal<Transaction[]>([]);
    transferTargets = signal<Account[]>([cash]);
    TestBed.configureTestingModule({
      providers: [
        { provide: TuiDialogService, useValue: { open } },
        { provide: TransactionsState, useValue: { transactions, selectedAccountIds: signal([]) } },
        {
          provide: AccountsState,
          useValue: { accounts: signal([cash, shared]), transferTargets, trackedIds: signal(new Set()) },
        },
        { provide: NotificationService, useValue: { showError } },
      ],
    });
    service = TestBed.inject(TransactionDialogService);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it('defaults to the local date, not the UTC one', async () => {
    vi.stubEnv('TZ', 'Europe/Moscow');
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-20T22:30:00Z')); // 01:30 on the 21st in Moscow
    await service.openCreate();
    expect(prefill().date).toBe('2026-10-21');
  });

  it('skips a last transaction on an account the user cannot write to', async () => {
    transactions.set([
      makeTransaction({ id: 9, debit_account: makeTxAccount(2, 'Shared read-only') }),
      makeTransaction({ id: 8, debit_account: makeTxAccount(1, 'Cash') }),
    ]);
    await service.openCreate();
    expect(prefill().debit_account?.id).toBe(1);
  });

  it('refuses when no account is writable, even with a read-only last transaction', async () => {
    transactions.set([makeTransaction({ debit_account: makeTxAccount(2, 'Shared read-only') })]);
    transferTargets.set([]);
    await service.openCreate();
    expect(open).not.toHaveBeenCalled();
    expect(showError).toHaveBeenCalledWith('No accounts available');
  });
});
