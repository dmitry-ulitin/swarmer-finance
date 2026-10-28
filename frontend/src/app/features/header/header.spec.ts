import { of } from 'rxjs';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Header } from './header';
import { AuthService } from '../../core/auth.service';
import { AccountsState } from '../../core/accounts.state';
import { TransactionsState } from '../../core/transactions.state';
import { CategoryDialogService } from '../categories/category-dialog.service';
import { AccountDialogService } from '../accounts/account-dialog.service';
import { TransactionDialogService } from '../transactions/transaction-dialog.service';
import { ImportDialogService } from '../import/import-dialog.service';
import { AccountSyncService } from '../accounts/account-sync.service';

const wallet = { id: 7, name: 'Wallet' };
const shared = { id: 9, name: 'Shared', access_level: 2 };
const readOnly = { id: 10, name: 'Read only', access_level: 1 };
const fund = { id: 11, name: 'Fund', type: 'investment', access_level: 2, in_net_worth: false };
const accounts = [fund, wallet, { id: 8, name: 'Cash' }, shared, readOnly];

function configure(selectedAccountIds: number[], selectedTransaction: unknown = null) {
  const openSharing = vi.fn(async () => {});
  const openEdit = vi.fn(async () => {});
  const openImport = vi.fn(async () => {});
  const sync = vi.fn(async () => {});
  const openValuations = vi.fn(async () => {});
  const setInNetWorth = vi.fn(() => of({ data: null, error: null }));
  TestBed.configureTestingModule({
    providers: [
      Header,
      { provide: AuthService, useValue: {} },
      { provide: AccountsState, useValue: { accounts: signal(accounts), visibleAccounts: signal(accounts), trackedIds: signal(new Set()), setInNetWorth } },
      { provide: TransactionsState, useValue: { selectedAccountIds: signal(selectedAccountIds), selectedTransaction: signal(selectedTransaction) } },
      { provide: CategoryDialogService, useValue: {} },
      { provide: AccountDialogService, useValue: { openSharing, openEdit, openValuations } },
      { provide: TransactionDialogService, useValue: {} },
      { provide: ImportDialogService, useValue: { open: openImport } },
      { provide: AccountSyncService, useValue: { sync } },
    ],
  });
  return { header: TestBed.inject(Header), openValuations, setInNetWorth, openSharing, openEdit, openImport, sync };
}

describe('Header sharing', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('opens sharing for the filtered account', () => {
    const { header, openSharing } = configure([7]);
    header.shareFilteredAccount();
    expect(openSharing).toHaveBeenCalledWith(wallet);
  });

  it('does nothing unless exactly one account is filtered', () => {
    const { header, openSharing } = configure([7, 8]);
    header.shareFilteredAccount();
    expect(openSharing).not.toHaveBeenCalled();
  });
});

describe('Header edit', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('edits a filtered account the user manages', () => {
    const { header, openEdit } = configure([7]);
    expect(header.canEditFiltered()).toBe(true);
    header.editFilteredAccount();
    expect(openEdit).toHaveBeenCalledWith(wallet);
  });

  it('does not offer editing below co-owner', () => {
    const { header, openEdit } = configure([9]);
    expect(header.canEditFiltered()).toBe(false);
    header.editFilteredAccount();
    expect(openEdit).not.toHaveBeenCalled();
  });
});

describe('Header import and sync', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('imports into and syncs a filtered account the user can write to', () => {
    const { header, openImport, sync } = configure([9]);
    expect(header.canWriteFiltered()).toBe(true);
    header.importFilteredAccount();
    header.syncFilteredAccount();
    expect(openImport).toHaveBeenCalledWith(shared);
    expect(sync).toHaveBeenCalledWith(shared);
  });

  it('does not offer them on a read-only account', () => {
    const { header, openImport, sync } = configure([10]);
    expect(header.canWriteFiltered()).toBe(false);
    header.importFilteredAccount();
    header.syncFilteredAccount();
    expect(openImport).not.toHaveBeenCalled();
    expect(sync).not.toHaveBeenCalled();
  });
});

describe('Header transaction actions', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('offers edit and delete with write access on every side', () => {
    const { header } = configure([], { id: 1, debit_account: wallet, credit_account: shared });
    expect(header.canWrite()).toBe(true);
    expect(header.canDelete()).toBe(true);
  });

  it('offers neither when one side is read-only', () => {
    const { header } = configure([], { id: 1, debit_account: wallet, credit_account: readOnly });
    expect(header.canWrite()).toBe(false);
    expect(header.canDelete()).toBe(false);
  });

  it('offers neither on a read-only expense', () => {
    const { header } = configure([], { id: 1, debit_account: readOnly, credit_account: null });
    expect(header.canWrite()).toBe(false);
  });
});

describe('Header net worth', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('opens valuations for a valued account with write access', () => {
    const { header, openValuations } = configure([11]);
    header.valuationsFiltered();
    expect(openValuations).toHaveBeenCalledWith(fund);
  });

  it('does not open valuations for a plain account', () => {
    const { header, openValuations } = configure([9]);
    header.valuationsFiltered();
    expect(openValuations).not.toHaveBeenCalled();
  });

  it('toggles net worth inclusion', () => {
    const { header, setInNetWorth } = configure([11]);
    header.toggleNetWorthFiltered();
    expect(setInNetWorth).toHaveBeenCalledWith(11, true);
  });
});
