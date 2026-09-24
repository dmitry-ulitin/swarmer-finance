import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { Observable, of, throwError } from 'rxjs';
import { AccountSyncService, describeSync } from './account-sync.service';
import { ApiService } from '../../core/api.service';
import { AccountsState } from '../../core/accounts.state';
import { TransactionsState } from '../../core/transactions.state';
import { NotificationService } from '../../core/notification.service';
import type { Account } from '../../models/account';

describe('describeSync', () => {
  it('says so when nothing changed', () => {
    expect(describeSync({ added: 0, merged: 0, fees: 0 })).toBe('Already up to date');
  });

  it('lists only non-zero counts', () => {
    expect(describeSync({ added: 12, merged: 0, fees: 3 })).toBe('12 transactions added, 3 fees');
    expect(describeSync({ added: 1, merged: 1, fees: 1 })).toBe('1 transaction added, 1 merged into a transfer, 1 fee');
  });
});

describe('AccountSyncService', () => {
  const account = { id: 7, name: 'Cold' } as Account;
  let api: { syncAccount: ReturnType<typeof vi.fn> };
  let notifications: { showSuccess: ReturnType<typeof vi.fn>; showError: ReturnType<typeof vi.fn> };
  let accounts: { reload: ReturnType<typeof vi.fn> };
  let transactions: { reload: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    TestBed.resetTestingModule();
    api = { syncAccount: vi.fn() };
    notifications = { showSuccess: vi.fn(), showError: vi.fn() };
    accounts = { reload: vi.fn() };
    transactions = { reload: vi.fn() };
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: ApiService, useValue: api },
        { provide: NotificationService, useValue: notifications },
        { provide: AccountsState, useValue: accounts },
        { provide: TransactionsState, useValue: transactions },
      ],
    });
  });

  it('reloads lists and reports the result', async () => {
    api.syncAccount.mockReturnValue(of({ data: { added: 2, merged: 0, fees: 1 }, error: null }));
    const service = TestBed.inject(AccountSyncService);

    await service.sync(account);

    expect(api.syncAccount).toHaveBeenCalledWith(7);
    expect(accounts.reload).toHaveBeenCalled();
    expect(transactions.reload).toHaveBeenCalled();
    expect(notifications.showSuccess).toHaveBeenCalledWith('2 transactions added, 1 fee');
    expect(service.syncing().has(7)).toBe(false);
  });

  it('shows the backend error and clears the busy flag', async () => {
    api.syncAccount.mockReturnValue(throwError(() => new Error('Blockchain API unavailable')));
    const service = TestBed.inject(AccountSyncService);

    await service.sync(account);

    expect(notifications.showError).toHaveBeenCalled();
    expect(service.syncing().has(7)).toBe(false);
  });

  it('ignores a second press while the first sync runs', async () => {
    let finish!: () => void;
    api.syncAccount.mockReturnValue(new Observable(sub => {
      finish = () => { sub.next({ data: { added: 0, merged: 0, fees: 0 }, error: null }); sub.complete(); };
    }));
    const service = TestBed.inject(AccountSyncService);

    const first = service.sync(account);
    expect(service.syncing().has(7)).toBe(true);
    await service.sync(account);
    finish();
    await first;

    expect(api.syncAccount).toHaveBeenCalledTimes(1);
  });
});
