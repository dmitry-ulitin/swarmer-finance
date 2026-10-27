import { afterNextRender, ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { TuiButton, TuiFilterByInputPipe, TuiInput } from '@taiga-ui/core';
import type { TuiDialogContext } from '@taiga-ui/core';
import { TuiChevron, TuiComboBox, TuiDataListWrapper } from '@taiga-ui/kit';
import { TuiAutoFocus } from '@taiga-ui/cdk/directives/auto-focus';
import { POLYMORPHEUS_CONTEXT } from '@taiga-ui/polymorpheus';
import { firstValueFrom } from 'rxjs';
import { AuthService } from '../../core/auth.service';
import { AccountsState } from '../../core/accounts.state';
import { TransactionsState } from '../../core/transactions.state';
import { NotificationService } from '../../core/notification.service';

@Component({
  selector: 'app-profile-form',
  imports: [ReactiveFormsModule, TuiButton, TuiInput, TuiChevron, TuiComboBox, TuiDataListWrapper, TuiFilterByInputPipe, TuiAutoFocus],
  templateUrl: './profile-form.html',
  styleUrl: './profile-form.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ProfileForm {
  private readonly context = inject<TuiDialogContext<boolean, void>>(POLYMORPHEUS_CONTEXT);
  private readonly auth = inject(AuthService);
  private readonly accountsState = inject(AccountsState);
  private readonly transactionsState = inject(TransactionsState);
  private readonly notifications = inject(NotificationService);

  readonly currencies = this.accountsState.currencies;
  readonly loading = signal(false);

  readonly form = new FormGroup({
    name: new FormControl(this.auth.user()?.name ?? '', { nonNullable: true, validators: [Validators.required] }),
    // Same free-text code as registration: 3 or 4 letters, upper-cased on submit.
    currency: new FormControl(this.auth.user()?.currency ?? '', { nonNullable: true, validators: [Validators.required, Validators.pattern(/^\s*[A-Za-z]{3,4}\s*$/)] }),
  });

  constructor() {
    // Same Taiga UI combo-box workaround as AccountForm: its first matching
    // run clears the initial value, so it is re-applied after rendering.
    const currency = this.auth.user()?.currency;
    if (currency) {
      afterNextRender(() => this.form.controls.currency.setValue(currency));
    }
  }

  cancel(): void {
    this.context.completeWith(false);
  }

  async onSubmit(): Promise<void> {
    if (this.form.invalid) return;
    const name = this.form.controls.name.value.trim();
    const currency = this.form.controls.currency.value.trim().toUpperCase();
    const currencyChanged = currency !== this.auth.user()?.currency;

    try {
      this.loading.set(true);
      await firstValueFrom(this.auth.updateProfile(name, currency));
      // Balances and the summary come converted into the user's currency.
      if (currencyChanged) {
        this.accountsState.reload();
        this.transactionsState.reload();
      }
      this.context.completeWith(true);
    } catch (e) {
      this.notifications.showError(e, 'Failed to save profile');
    } finally {
      this.loading.set(false);
    }
  }
}
