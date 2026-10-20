import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ApplicationRef as ApplicationRef, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { AccountsState } from './accounts.state';
import { ApiService } from './api.service';
import { AuthService } from './auth.service';
import { NotificationService } from './notification.service';

describe('AccountsState when the load fails', () => {
  let getAccounts: ReturnType<typeof vi.fn>;
  let showError: ReturnType<typeof vi.fn>;
  let state: AccountsState;

  beforeEach(() => {
    const error = new Error('down');
    getAccounts = vi.fn(() => throwError(() => error));
    showError = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        { provide: ApiService, useValue: { getAccounts } },
        { provide: AuthService, useValue: { isAuthenticated: signal(true), user: signal(null) } },
        { provide: NotificationService, useValue: { showError } },
      ],
    });
    state = TestBed.inject(AccountsState);
  });

  it('shows no accounts instead of throwing, and reports the error', async () => {
    await TestBed.inject(ApplicationRef).whenStable();
    expect(state.accounts()).toEqual([]);
    expect(state.accountSections()).toEqual([]);
    expect(showError).toHaveBeenCalledWith(expect.any(Error), 'Failed to load accounts');
  });

  it('recovers on reload', async () => {
    await TestBed.inject(ApplicationRef).whenStable();
    getAccounts.mockReturnValue(of({ data: [{ id: 1, name: 'Cash', deleted: false }], error: null }));
    state.reload();
    await TestBed.inject(ApplicationRef).whenStable();
    expect(state.accounts().map(a => a.id)).toEqual([1]);
  });
});
