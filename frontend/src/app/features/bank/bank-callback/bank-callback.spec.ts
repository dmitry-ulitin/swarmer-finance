import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { of, throwError } from 'rxjs';
import { BankCallback } from './bank-callback';
import { ApiService } from '../../../core/api.service';
import { NotificationService } from '../../../core/notification.service';
import { BankDialogService } from '../bank-dialog.service';

async function render(query: Record<string, string>, complete = vi.fn(() => of({ data: { accounts: [{ uid: 'u1' }] }, error: null }))) {
  const api = { completeBankConnection: complete };
  const router = { navigate: vi.fn(() => Promise.resolve(true)) };
  const notifications = { showError: vi.fn(), showSuccess: vi.fn() };
  const dialogs = { openConnections: vi.fn(() => Promise.resolve()) };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: ApiService, useValue: api },
      { provide: Router, useValue: router },
      { provide: NotificationService, useValue: notifications },
      { provide: BankDialogService, useValue: dialogs },
      { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: { get: (k: string) => query[k] ?? null } } } },
    ],
  });
  const fixture = TestBed.createComponent(BankCallback);
  await fixture.whenStable();
  return { api, router, notifications, dialogs };
}

describe('BankCallback', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('completes the connection, goes to the dashboard and opens the connections dialog', async () => {
    const { api, router, dialogs, notifications } = await render({ state: 's', code: 'c' });
    expect(api.completeBankConnection).toHaveBeenCalledWith('s', 'c');
    expect(router.navigate).toHaveBeenCalledWith(['/dashboard'], { replaceUrl: true });
    expect(dialogs.openConnections).toHaveBeenCalled();
    expect(notifications.showSuccess).toHaveBeenCalledWith('Bank connected');
  });

  it('warns when the bank shared no accounts', async () => {
    const { notifications, dialogs } = await render({ state: 's', code: 'c' }, vi.fn(() => of({ data: { accounts: [] }, error: null })));
    expect(notifications.showSuccess).not.toHaveBeenCalled();
    expect(notifications.showError).toHaveBeenCalledWith(expect.stringContaining('Link accounts'));
    expect(dialogs.openConnections).toHaveBeenCalled();
  });

  it('shows the error and does not complete when the bank reports one', async () => {
    const { api, router, dialogs, notifications } = await render({ error: 'access_denied' });
    expect(api.completeBankConnection).not.toHaveBeenCalled();
    expect(notifications.showError).toHaveBeenCalled();
    expect(router.navigate).toHaveBeenCalledWith(['/dashboard'], { replaceUrl: true });
    expect(dialogs.openConnections).toHaveBeenCalled();
  });

  it('shows the backend message when completing fails', async () => {
    const err = new Error('Unknown or expired connection request');
    const { notifications, dialogs } = await render({ state: 's', code: 'c' }, vi.fn(() => throwError(() => err)));
    expect(notifications.showError).toHaveBeenCalledWith(err, 'Failed to connect the bank');
    expect(dialogs.openConnections).toHaveBeenCalled();
  });
});
