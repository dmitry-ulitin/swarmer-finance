import { describe, it, expect, beforeEach, vi } from 'vitest';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Accounts } from './accounts';
import { AccountsState } from '../../core/accounts.state';
import { AccountDialogService } from './account-dialog.service';
import { AuthService } from '../../core/auth.service';
import type { Account } from '../../models/account';

function makeAccount(id: number, access_level?: 1 | 2 | 3 | 4): Account {
  return {
    id, user_id: 1, name: `A${id}`, currency: 'USD', scale: 2, balance: 0, user_balance: 0,
    start_balance: 0, deleted: false, created_at: '', type: 'cash', settings: {}, access_level,
  };
}

const accounts = [makeAccount(1, 4), makeAccount(2, 3), makeAccount(3, 2), makeAccount(4)];

function configure(dialogs: Partial<AccountDialogService> = {}) {
  TestBed.configureTestingModule({
    providers: [
      Accounts,
      { provide: AccountsState, useValue: { visibleAccounts: signal(accounts) } },
      { provide: AccountDialogService, useValue: dialogs },
      { provide: AuthService, useValue: { user: signal(null) } },
    ],
  });
  return TestBed.inject(Accounts);
}

describe('Accounts danger actions', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('are offered to the owner and to admins only', () => {
    const screen = configure();
    const offered = accounts.map(a => {
      screen.setAsSelected(a);
      return screen.canPurge();
    });
    // No access_level means an account of the user's own, as in AccountsState.
    expect(offered).toEqual([true, true, false, true]);
  });

  it('are not offered without a selection', () => {
    expect(configure().canPurge()).toBe(false);
  });

  it('clears the selection once the account is deleted with its transactions', async () => {
    const screen = configure({ openDeleteWithTransactions: vi.fn(async () => true) });
    screen.setAsSelected(accounts[0]);

    await screen.openDeleteWithTransactionsDialog();

    expect(screen.selectedId()).toBeNull();
  });
});

describe('Accounts sections', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('group by access level, highest first, and name the owner below admin', () => {
    const shared = (id: number, name: string, level: 1 | 2 | 3) =>
      ({ ...makeAccount(id, level), name, user_id: 7, owner_name: 'Bob' });
    TestBed.configureTestingModule({
      providers: [
        Accounts,
        {
          provide: AccountsState, useValue: {
            visibleAccounts: signal([
              shared(1, 'b', 1), { ...makeAccount(2), name: 'Z' }, shared(3, 'c', 3),
              shared(4, 'a', 1), { ...makeAccount(5, 4), name: 'y' },
            ]),
          },
        },
        { provide: AccountDialogService, useValue: {} },
        { provide: AuthService, useValue: { user: signal(null) } },
      ],
    });
    const sections = TestBed.inject(Accounts).sections();

    expect(sections.map(s => [s.access_level, s.accounts.map(a => a.displayName)])).toEqual([
      [4, ['y', 'Z']],
      [3, ['c']],
      [1, ['a (Bob)', 'b (Bob)']],
    ]);
  });
});
