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
      expect.objectContaining({ account: [1], details: 'coffee', offset: 0 }),
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
      expect.objectContaining({ account: [1], category: [9], offset: 0 }),
    );
  });

  it('clears the filter when the sole selected category is selected again', () => {
    state.selectCategory(9);
    state.selectCategory(9);
    expect(state.selectedCategoryIds()).toEqual([]);
    expect(getTransactions.mock.lastCall![0].category).toBeUndefined();
  });

  it('toggles categories in and out of the filter', () => {
    state.toggleCategory(7);
    state.toggleCategory(9);
    expect(state.selectedCategoryIds()).toEqual([7, 9]);
    state.toggleCategory(7);
    expect(state.selectedCategoryIds()).toEqual([9]);
    state.toggleCategory(9);
    expect(getTransactions.mock.lastCall![0].category).toBeUndefined();
  });
});
