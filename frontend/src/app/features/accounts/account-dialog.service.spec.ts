import { TestBed } from '@angular/core/testing';
import { TuiDialogService } from '@taiga-ui/core';
import { of, throwError } from 'rxjs';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AccountDialogService } from './account-dialog.service';
import { AccountsState } from '../../core/accounts.state';
import { AuthService } from '../../core/auth.service';
import { TransactionsState } from '../../core/transactions.state';
import { NotificationService } from '../../core/notification.service';
import type { Account } from '../../models/account';

const account: Account = {
  id: 7, user_id: 1, name: 'Wallet', currency: 'USD', scale: 2, balance: 0, user_balance: 0,
  start_balance: 0, deleted: false, created_at: '', type: 'cash', settings: {},
};

describe('AccountDialogService.openDelete', () => {
  let service: AccountDialogService;
  let dialogOpen: ReturnType<typeof vi.fn>;
  let deleteAccount: ReturnType<typeof vi.fn>;
  let showError: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    dialogOpen = vi.fn(() => of(true));
    deleteAccount = vi.fn(() => of({ data: null, error: null }));
    showError = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        { provide: TuiDialogService, useValue: { open: dialogOpen } },
        { provide: AccountsState, useValue: { delete: deleteAccount } },
        { provide: AuthService, useValue: { user: () => null } },
        { provide: TransactionsState, useValue: { reload: vi.fn() } },
        { provide: NotificationService, useValue: { showError } },
      ],
    });
    service = TestBed.inject(AccountDialogService);
  });

  it('deletes the account once confirmed', async () => {
    expect(await service.openDelete(account)).toBe(true);
    expect(deleteAccount).toHaveBeenCalledWith(7);
    expect(showError).not.toHaveBeenCalled();
  });

  it('does not delete when cancelled', async () => {
    dialogOpen.mockReturnValue(of(false));
    expect(await service.openDelete(account)).toBe(false);
    expect(deleteAccount).not.toHaveBeenCalled();
  });

  it('reports a failed delete instead of rejecting', async () => {
    const err = new Error('boom');
    deleteAccount.mockReturnValue(throwError(() => err));
    expect(await service.openDelete(account)).toBe(false);
    expect(showError).toHaveBeenCalledWith(err, 'Failed to delete account');
  });
});

describe('AccountDialogService purge actions', () => {
  let service: AccountDialogService;
  let dialogOpen: ReturnType<typeof vi.fn>;
  let purgeTransactions: ReturnType<typeof vi.fn>;
  let deleteWithTransactions: ReturnType<typeof vi.fn>;
  let reloadTransactions: ReturnType<typeof vi.fn>;
  let showError: ReturnType<typeof vi.fn>;
  let showSuccess: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    dialogOpen = vi.fn(() => of(true));
    purgeTransactions = vi.fn(() => of({ data: { deleted: 3, detached: 1 }, error: null }));
    deleteWithTransactions = vi.fn(() => of({ data: { deleted: 1, detached: 0 }, error: null }));
    reloadTransactions = vi.fn();
    showError = vi.fn();
    showSuccess = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        { provide: TuiDialogService, useValue: { open: dialogOpen } },
        { provide: AccountsState, useValue: { purgeTransactions, deleteWithTransactions } },
        { provide: TransactionsState, useValue: { reload: reloadTransactions } },
        { provide: AuthService, useValue: { user: () => null } },
        { provide: NotificationService, useValue: { showError, showSuccess } },
      ],
    });
    service = TestBed.inject(AccountDialogService);
  });

  it('purges transactions once confirmed and reports the counts', async () => {
    expect(await service.openPurgeTransactions(account)).toBe(true);
    expect(purgeTransactions).toHaveBeenCalledWith(7);
    expect(reloadTransactions).toHaveBeenCalled();
    expect(showSuccess).toHaveBeenCalledWith('3 transactions deleted, 1 transfer kept as uncategorized');
  });

  it('deletes the account with its transactions once confirmed', async () => {
    expect(await service.openDeleteWithTransactions(account)).toBe(true);
    expect(deleteWithTransactions).toHaveBeenCalledWith(7);
    expect(reloadTransactions).toHaveBeenCalled();
    expect(showSuccess).toHaveBeenCalledWith('Account deleted, 1 transaction deleted');
  });

  it('does nothing when cancelled', async () => {
    dialogOpen.mockReturnValue(of(false));
    expect(await service.openPurgeTransactions(account)).toBe(false);
    expect(await service.openDeleteWithTransactions(account)).toBe(false);
    expect(purgeTransactions).not.toHaveBeenCalled();
    expect(deleteWithTransactions).not.toHaveBeenCalled();
  });

  it('reports a failure instead of rejecting', async () => {
    const err = new Error('boom');
    purgeTransactions.mockReturnValue(throwError(() => err));
    deleteWithTransactions.mockReturnValue(throwError(() => err));
    expect(await service.openPurgeTransactions(account)).toBe(false);
    expect(await service.openDeleteWithTransactions(account)).toBe(false);
    expect(showError).toHaveBeenCalledWith(err, 'Failed to delete transactions');
    expect(showError).toHaveBeenCalledWith(err, 'Failed to delete account');
  });
});
