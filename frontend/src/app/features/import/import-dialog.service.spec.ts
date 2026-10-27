import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { TuiDialogService } from '@taiga-ui/core';
import { ImportDialogService } from './import-dialog.service';
import { TransactionsState } from '../../core/transactions.state';
import { AccountsState } from '../../core/accounts.state';
import { NotificationService } from '../../core/notification.service';
import { ApiService } from '../../core/api.service';
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

describe('ImportDialogService.openFromBank', () => {
  const linked = (loadedTo: string | null) =>
    ({ ...account, bank_link: { loadedTo } }) as unknown as Account;
  const parsed = (rows: unknown[]) =>
    ({ account, rows, bank: { dateFrom: '2026-07-01', dateTo: '2026-10-27' } }) as never;

  function setup(loaded: ReturnType<typeof parsed>) {
    const open = vi.fn().mockReturnValue(of('2026-08-01'));
    const loadFromBank = vi.fn().mockReturnValue(of({ data: loaded, error: null }));
    const reconcileImport = vi.fn().mockReturnValue(of({ data: { created: 0, skipped: 0 }, error: null }));
    const showSuccess = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        { provide: TuiDialogService, useValue: { open } },
        { provide: ApiService, useValue: { loadFromBank, reconcileImport } },
        { provide: TransactionsState, useValue: { reload: vi.fn() } },
        { provide: AccountsState, useValue: { reload: vi.fn() } },
        { provide: NotificationService, useValue: { showError: vi.fn(), showSuccess } },
      ],
    });
    const service = TestBed.inject(ImportDialogService);
    const openReview = vi.fn().mockResolvedValue({ created: 2, skipped: 0 });
    (service as unknown as { openReview: unknown }).openReview = openReview;
    return { service, open, loadFromBank, reconcileImport, showSuccess, openReview };
  }

  beforeEach(() => TestBed.resetTestingModule());

  it('asks for the start date on the first load and passes it on', async () => {
    const s = setup(parsed([{}]));
    await s.service.openFromBank(linked(null));
    expect(s.open).toHaveBeenCalledTimes(1);
    expect(s.loadFromBank).toHaveBeenCalledWith(1, '2026-08-01');
    expect(s.openReview).toHaveBeenCalled();
  });

  it('ends everything when the date dialog is cancelled', async () => {
    const s = setup(parsed([{}]));
    s.open.mockReturnValue(of(null));
    await expect(s.service.openFromBank(linked(null))).resolves.toBeNull();
    expect(s.loadFromBank).not.toHaveBeenCalled();
  });

  it('skips the date dialog on later loads', async () => {
    const s = setup(parsed([{}]));
    await s.service.openFromBank(linked('2026-10-01'));
    expect(s.open).not.toHaveBeenCalled();
    expect(s.loadFromBank).toHaveBeenCalledWith(1, undefined);
  });

  it('marks the window loaded without a review when there are no rows', async () => {
    const s = setup(parsed([]));
    await s.service.openFromBank(linked('2026-10-01'));
    expect(s.reconcileImport).toHaveBeenCalledWith(1, [], '2026-10-27');
    expect(s.openReview).not.toHaveBeenCalled();
    expect(s.showSuccess).toHaveBeenCalledWith('No new transactions in the bank');
  });
});
