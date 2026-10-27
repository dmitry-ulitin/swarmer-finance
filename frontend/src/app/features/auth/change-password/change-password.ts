import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { AbstractControl, FormControl, FormGroup, ReactiveFormsModule, ValidationErrors, Validators } from '@angular/forms';
import { TuiButton, TuiIcon, TuiInput } from '@taiga-ui/core';
import type { TuiDialogContext } from '@taiga-ui/core';
import { TuiPassword } from '@taiga-ui/kit';
import { TuiAutoFocus } from '@taiga-ui/cdk/directives/auto-focus';
import { POLYMORPHEUS_CONTEXT } from '@taiga-ui/polymorpheus';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../../core/auth.service';
import { NotificationService } from '../../../core/notification.service';

/** Mirrors the backend's minimum for a new password. */
export const MIN_PASSWORD_LENGTH = 8;

function passwordsMatch(group: AbstractControl): ValidationErrors | null {
  const { newPassword, confirm } = group.value;
  return newPassword === confirm ? null : { mismatch: true };
}

@Component({
  selector: 'app-change-password',
  imports: [ReactiveFormsModule, TuiButton, TuiIcon, TuiInput, TuiPassword, TuiAutoFocus],
  templateUrl: './change-password.html',
  styleUrl: './change-password.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ChangePassword {
  private readonly context = inject<TuiDialogContext<boolean, void>>(POLYMORPHEUS_CONTEXT);
  private readonly auth = inject(AuthService);
  private readonly notifications = inject(NotificationService);

  readonly minLength = MIN_PASSWORD_LENGTH;
  readonly loading = signal(false);

  readonly form = new FormGroup({
    currentPassword: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
    newPassword: new FormControl('', { nonNullable: true, validators: [Validators.required, Validators.minLength(MIN_PASSWORD_LENGTH)] }),
    confirm: new FormControl('', { nonNullable: true, validators: [Validators.required] }),
  }, { validators: passwordsMatch });

  cancel(): void {
    this.context.completeWith(false);
  }

  async onSubmit(): Promise<void> {
    if (this.form.invalid) return;
    const { currentPassword, newPassword } = this.form.getRawValue();

    try {
      this.loading.set(true);
      await firstValueFrom(this.auth.changePassword(currentPassword, newPassword));
      this.notifications.showSuccess('Password changed');
      this.context.completeWith(true);
    } catch (e) {
      this.notifications.showError(e, 'Failed to change password');
    } finally {
      this.loading.set(false);
    }
  }
}
