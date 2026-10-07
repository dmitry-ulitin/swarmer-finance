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
