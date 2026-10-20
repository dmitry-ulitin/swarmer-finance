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

function configure(selectedAccountIds: number[]) {
  const openSharing = vi.fn(async () => {});
  TestBed.configureTestingModule({
    providers: [
      Header,
      { provide: AuthService, useValue: {} },
      { provide: AccountsState, useValue: { visibleAccounts: signal([wallet, { id: 8, name: 'Cash' }]), trackedIds: signal(new Set()) } },
      { provide: TransactionsState, useValue: { selectedAccountIds: signal(selectedAccountIds), selectedTransaction: signal(null) } },
      { provide: CategoryDialogService, useValue: {} },
      { provide: AccountDialogService, useValue: { openSharing } },
      { provide: TransactionDialogService, useValue: {} },
      { provide: ImportDialogService, useValue: {} },
      { provide: AccountSyncService, useValue: {} },
    ],
  });
  return { header: TestBed.inject(Header), openSharing };
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
