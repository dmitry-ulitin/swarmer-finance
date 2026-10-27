import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { of, throwError } from 'rxjs';
import { POLYMORPHEUS_CONTEXT } from '@taiga-ui/polymorpheus';
import { ChangePassword } from './change-password';
import { AuthService } from '../../../core/auth.service';
import { NotificationService } from '../../../core/notification.service';

function createForm(changePassword = vi.fn(() => of({ data: { success: true }, error: null }))) {
  const completeWith = vi.fn();
  const notifications = { showSuccess: vi.fn(), showError: vi.fn() };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: POLYMORPHEUS_CONTEXT, useValue: { completeWith } },
      { provide: AuthService, useValue: { changePassword } },
      { provide: NotificationService, useValue: notifications },
    ],
  });
  const form = TestBed.createComponent(ChangePassword).componentInstance;
  return { form, completeWith, changePassword, notifications };
}

describe('ChangePassword', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('is invalid when the repeated password differs', () => {
    const { form } = createForm();
    form.form.setValue({ currentPassword: 'old-pass', newPassword: 'new-password', confirm: 'new-passw0rd' });

    expect(form.form.hasError('mismatch')).toBe(true);
    expect(form.form.invalid).toBe(true);
  });

  it('is invalid when the new password is shorter than 8 characters', () => {
    const { form } = createForm();
    form.form.setValue({ currentPassword: 'old-pass', newPassword: 'short', confirm: 'short' });

    expect(form.form.controls.newPassword.hasError('minlength')).toBe(true);
  });

  it('does not submit an invalid form', async () => {
    const { form, changePassword } = createForm();
    form.form.setValue({ currentPassword: 'old-pass', newPassword: 'new-password', confirm: 'other' });

    await form.onSubmit();

    expect(changePassword).not.toHaveBeenCalled();
  });

  it('sends current and new password and closes with true', async () => {
    const { form, changePassword, completeWith, notifications } = createForm();
    form.form.setValue({ currentPassword: 'old-pass', newPassword: 'new-password', confirm: 'new-password' });

    await form.onSubmit();

    expect(changePassword).toHaveBeenCalledWith('old-pass', 'new-password');
    expect(notifications.showSuccess).toHaveBeenCalled();
    expect(completeWith).toHaveBeenCalledWith(true);
  });

  it('stays open and shows the error when the backend refuses', async () => {
    const { form, completeWith, notifications } = createForm(vi.fn(() => throwError(() => new Error('Current password is incorrect'))));
    form.form.setValue({ currentPassword: 'wrong', newPassword: 'new-password', confirm: 'new-password' });

    await form.onSubmit();

    expect(notifications.showError).toHaveBeenCalled();
    expect(completeWith).not.toHaveBeenCalled();
    expect(form.loading()).toBe(false);
  });
});
