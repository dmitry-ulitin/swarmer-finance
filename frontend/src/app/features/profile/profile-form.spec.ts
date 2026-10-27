import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { of, throwError } from 'rxjs';
import { POLYMORPHEUS_CONTEXT } from '@taiga-ui/polymorpheus';
import { ProfileForm } from './profile-form';
import { AuthService } from '../../core/auth.service';
import { AccountsState } from '../../core/accounts.state';
import { TransactionsState } from '../../core/transactions.state';
import { NotificationService } from '../../core/notification.service';

const user = { id: 1, email: 'a@example.com', name: 'Dmitry', currency: 'EUR', currency_scale: 2 };

function createForm(updateProfile = vi.fn(() => of({ data: user, error: null }))) {
  const completeWith = vi.fn();
  const accounts = { currencies: signal(['EUR', 'USD']), reload: vi.fn() };
  const transactions = { reload: vi.fn() };
  const notifications = { showError: vi.fn() };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: POLYMORPHEUS_CONTEXT, useValue: { completeWith } },
      { provide: AuthService, useValue: { user: signal(user), updateProfile } },
      { provide: AccountsState, useValue: accounts },
      { provide: TransactionsState, useValue: transactions },
      { provide: NotificationService, useValue: notifications },
    ],
  });
  const form = TestBed.createComponent(ProfileForm).componentInstance;
  return { form, completeWith, updateProfile, accounts, transactions, notifications };
}

describe('ProfileForm', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('starts with the current name and currency', () => {
    const { form } = createForm();
    expect(form.form.getRawValue()).toEqual({ name: 'Dmitry', currency: 'EUR' });
  });

  it('refuses an empty name and a malformed currency', () => {
    const { form } = createForm();
    form.form.setValue({ name: '', currency: 'EURO1' });
    expect(form.form.controls.name.invalid).toBe(true);
    expect(form.form.controls.currency.invalid).toBe(true);
  });

  it('sends a trimmed name and upper-cased currency, then reloads the converted data', async () => {
    const { form, updateProfile, accounts, transactions, completeWith } = createForm();
    form.form.setValue({ name: ' Dima ', currency: ' usd ' });

    await form.onSubmit();

    expect(updateProfile).toHaveBeenCalledWith('Dima', 'USD');
    expect(accounts.reload).toHaveBeenCalled();
    expect(transactions.reload).toHaveBeenCalled();
    expect(completeWith).toHaveBeenCalledWith(true);
  });

  it('does not reload when only the name changes', async () => {
    const { form, accounts, transactions } = createForm();
    form.form.setValue({ name: 'Dima', currency: 'EUR' });

    await form.onSubmit();

    expect(accounts.reload).not.toHaveBeenCalled();
    expect(transactions.reload).not.toHaveBeenCalled();
  });

  it('stays open and shows the error when saving fails', async () => {
    const { form, completeWith, notifications } = createForm(vi.fn(() => throwError(() => new Error('boom'))));

    await form.onSubmit();

    expect(notifications.showError).toHaveBeenCalled();
    expect(completeWith).not.toHaveBeenCalled();
  });
});
