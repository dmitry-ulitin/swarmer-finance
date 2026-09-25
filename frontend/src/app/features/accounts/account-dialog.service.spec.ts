import { TestBed } from '@angular/core/testing';
import { TuiDialogService } from '@taiga-ui/core';
import { of, throwError } from 'rxjs';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { AccountDialogService } from './account-dialog.service';
import { AccountsState } from '../../core/accounts.state';
import { AuthService } from '../../core/auth.service';
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
