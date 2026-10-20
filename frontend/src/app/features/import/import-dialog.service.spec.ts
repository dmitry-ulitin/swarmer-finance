import { describe, it, expect, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { throwError } from 'rxjs';
import { TuiDialogService } from '@taiga-ui/core';
import { ImportDialogService } from './import-dialog.service';
import { TransactionsState } from '../../core/transactions.state';
import { AccountsState } from '../../core/accounts.state';
import { NotificationService } from '../../core/notification.service';
import type { Account } from '../../models/account';

const account = { id: 1, name: 'Bank', currency: 'EUR', type: 'bank', settings: {} } as Account;

describe('ImportDialogService.open', () => {
  it('reports a dialog that fails to open instead of rejecting', async () => {
    const error = new Error('chunk failed');
    const showError = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        { provide: TuiDialogService, useValue: { open: () => throwError(() => error) } },
        { provide: TransactionsState, useValue: {} },
        { provide: AccountsState, useValue: {} },
        { provide: NotificationService, useValue: { showError } },
      ],
    });

    await expect(TestBed.inject(ImportDialogService).open(account)).resolves.toBeNull();
    expect(showError).toHaveBeenCalledWith(error, 'Failed to open import');
  });
});
