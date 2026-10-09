import { describe, it, expect, beforeEach, vi } from 'vitest';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { TransactionsState } from './transactions.state';
import { ApiService } from './api.service';
import { AuthService } from './auth.service';
import { AccountsState } from './accounts.state';

describe('TransactionsState.setDetails', () => {
  let state: TransactionsState;
  let getTransactions: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    getTransactions = vi.fn(() => of({ data: [], error: null }));
    TestBed.configureTestingModule({
      providers: [
        { provide: ApiService, useValue: { getTransactions } },
        { provide: AuthService, useValue: { isAuthenticated: () => true } },
        { provide: AccountsState, useValue: { accounts: signal([{ id: 1 }, { id: 2 }]) } },
      ],
    });
    state = TestBed.inject(TransactionsState);
  });

  it('reloads with the search text, keeping the account filter', () => {
    state.selectAccount(1);
    state.setDetails('coffee');
    expect(getTransactions).toHaveBeenLastCalledWith(
      expect.objectContaining({ accounts: [1], details: 'coffee', offset: 0 }),
    );
  });

  it('bumps the revision on every reload', () => {
    const before = state.revision();
    state.setDetails('coffee');
    state.reload();
    expect(state.revision()).toBe(before + 2);
  });

  it('does not reload when the text is unchanged', () => {
    state.setDetails('coffee');
    getTransactions.mockClear();
    state.setDetails('coffee');
    expect(getTransactions).not.toHaveBeenCalled();
  });

  it('clears the filter with undefined', () => {
    state.setDetails('coffee');
    state.setDetails(undefined);
    expect(getTransactions.mock.lastCall![0].details).toBeUndefined();
  });
});

describe('TransactionsState.setDateRange', () => {
  let state: TransactionsState;
  let getTransactions: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    getTransactions = vi.fn(() => of({ data: [], error: null }));
    TestBed.configureTestingModule({
      providers: [
        { provide: ApiService, useValue: { getTransactions } },
        { provide: AuthService, useValue: { isAuthenticated: () => true } },
        { provide: AccountsState, useValue: { accounts: signal([{ id: 1 }, { id: 2 }]) } },
      ],
    });
    state = TestBed.inject(TransactionsState);
  });

  it('reloads with the dates, keeping the other filters', () => {
    state.setDetails('coffee');
    state.setDateRange({ from: '2026-09-01', to: '2026-09-30' });
    expect(getTransactions).toHaveBeenLastCalledWith(
      expect.objectContaining({ details: 'coffee', from: '2026-09-01', to: '2026-09-30', offset: 0 }),
    );
    expect(state.dateRange()).toEqual({ from: '2026-09-01', to: '2026-09-30' });
  });

  it('does not reload when the dates are unchanged', () => {
    state.setDateRange({ from: '2026-09-01', to: '2026-09-30' });
    getTransactions.mockClear();
    state.setDateRange({ from: '2026-09-01', to: '2026-09-30' });
    expect(getTransactions).not.toHaveBeenCalled();
  });

  it('clears the dates with null', () => {
    state.setDateRange({ from: '2026-09-01', to: '2026-09-30' });
    state.setDateRange(null);
    const filters = getTransactions.mock.lastCall![0];
    expect(filters.from).toBeUndefined();
    expect(filters.to).toBeUndefined();
    expect(state.dateRange()).toBeNull();
  });
});

describe('TransactionsState category filter', () => {
  let state: TransactionsState;
  let getTransactions: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    getTransactions = vi.fn(() => of({ data: [], error: null }));
    TestBed.configureTestingModule({
      providers: [
        { provide: ApiService, useValue: { getTransactions } },
        { provide: AuthService, useValue: { isAuthenticated: () => true } },
        { provide: AccountsState, useValue: { accounts: signal([{ id: 1 }, { id: 2 }]) } },
      ],
    });
    state = TestBed.inject(TransactionsState);
  });

  it('selects one category, replacing the previous ones and keeping the account filter', () => {
    state.selectAccount(1);
    state.toggleCategory(7);
    state.selectCategory(9);
    expect(state.selectedCategoryIds()).toEqual([9]);
    expect(getTransactions).toHaveBeenLastCalledWith(
      expect.objectContaining({ accounts: [1], categories: [9], offset: 0 }),
    );
  });

  it('clears the filter when the sole selected category is selected again', () => {
    state.selectCategory(9);
    state.selectCategory(9);
    expect(state.selectedCategoryIds()).toEqual([]);
    expect(getTransactions.mock.lastCall![0].categories).toBeUndefined();
  });

  it('toggles categories in and out of the filter', () => {
    state.toggleCategory(7);
    state.toggleCategory(9);
    expect(state.selectedCategoryIds()).toEqual([7, 9]);
    state.toggleCategory(7);
    expect(state.selectedCategoryIds()).toEqual([9]);
    state.toggleCategory(9);
    expect(getTransactions.mock.lastCall![0].categories).toBeUndefined();
  });
});

describe('TransactionsState.viewTransactions', () => {
  const usd = { id: 1, name: 'Cash', currency: 'USD', scale: 2, balance: 500 };
  const btc = { id: 2, name: 'Wallet', currency: 'BTC', scale: 8, balance: 7 };
  const base = { id: 10, user_id: 1, category: null, currency: null, scale: null, date: '2026-09-01', description: '', payee: null, txid: null, created_at: '' };
  const expense = { ...base, id: 11, debit_account: usd, credit_account: null, debit: 100, credit: 100 };
  const income = { ...base, id: 12, debit_account: null, credit_account: btc, debit: 3, credit: 3 };
  const transfer = { ...base, id: 13, debit_account: usd, credit_account: btc, debit: 200, credit: 4 };
  let state: TransactionsState;

  beforeEach(async () => {
    TestBed.configureTestingModule({
      providers: [
        { provide: ApiService, useValue: { getTransactions: () => of({ data: [expense, income, transfer], error: null }) } },
        { provide: AuthService, useValue: { isAuthenticated: () => true } },
        { provide: AccountsState, useValue: { accounts: signal([{ id: 1 }, { id: 2 }, { id: 3 }]) } },
      ],
    });
    state = TestBed.inject(TransactionsState);
  });

  async function view() {
    await Promise.resolve();
    return state.viewTransactions().map(({ accountName, amount, amountCurrency, amountScale, balance, balanceCurrency, balanceScale }) =>
      ({ accountName, amount, amountCurrency, amountScale, balance, balanceCurrency, balanceScale }));
  }

  it('shows expenses on the debit side, income and unfiltered transfers on their own side', async () => {
    state.reload();
    expect(await view()).toEqual([
      { accountName: 'Cash', amount: 100, amountCurrency: 'USD', amountScale: 2, balance: 500, balanceCurrency: 'USD', balanceScale: 2 },
      { accountName: 'Wallet', amount: 3, amountCurrency: 'BTC', amountScale: 8, balance: 7, balanceCurrency: 'BTC', balanceScale: 8 },
      { accountName: 'Cash → Wallet', amount: 200, amountCurrency: 'USD', amountScale: 2, balance: 500, balanceCurrency: 'USD', balanceScale: 2 },
    ]);
  });

  it('shows a transfer on the credit side when only the receiving account is filtered', async () => {
    state.selectAccount(2);
    expect((await view())[2]).toEqual(
      { accountName: 'Cash → Wallet', amount: 4, amountCurrency: 'BTC', amountScale: 8, balance: 7, balanceCurrency: 'BTC', balanceScale: 8 },
    );
  });

  it('keeps a transfer on the debit side when both its accounts are filtered', async () => {
    state.selectAccounts([1, 2]);
    expect((await view())[2].amount).toBe(200);
  });
});

describe('TransactionsState on logout', () => {
  it('drops the filters and loaded transactions', () => {
    const isAuthenticated = signal(true);
    const getTransactions = vi.fn((_: object) => of({ data: [{ id: 7 }], error: null }));
    TestBed.configureTestingModule({
      providers: [
        { provide: ApiService, useValue: { getTransactions } },
        { provide: AuthService, useValue: { isAuthenticated } },
        { provide: AccountsState, useValue: { accounts: signal([{ id: 1 }, { id: 2 }]) } },
      ],
    });
    const state = TestBed.inject(TransactionsState);
    state.selectAccount(1);
    state.selectCategory(5);
    state.setDateRange({ from: '2026-01-01', to: '2026-01-31' });
    state.setDetails('coffee');
    TestBed.tick();

    isAuthenticated.set(false);
    TestBed.tick();

    expect(state.selectedAccountIds()).toEqual([]);
    expect(state.selectedCategoryIds()).toEqual([]);
    expect(state.dateRange()).toBeNull();
    expect(state.transactions()).toEqual([]);

    isAuthenticated.set(true);
    state.reload();
    expect(getTransactions.mock.lastCall![0]).toEqual({ offset: 0, limit: 20 });
  });
});
