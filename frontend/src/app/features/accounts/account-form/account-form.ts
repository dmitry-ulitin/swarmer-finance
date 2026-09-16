import { afterNextRender, ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { TuiButton, TuiError, TuiFilterByInputPipe, TuiInput } from '@taiga-ui/core';
import { TuiChevron, TuiComboBox, TuiDataListWrapper, TuiInputNumber } from '@taiga-ui/kit';
import { TuiValidationError } from '@taiga-ui/cdk/classes';
import { POLYMORPHEUS_CONTEXT } from '@taiga-ui/polymorpheus';
import type { TuiDialogContext } from '@taiga-ui/core';
import { AccountsState } from '../../../core/accounts.state';
import type { Account } from '../../../models/account';
import { firstValueFrom } from 'rxjs';
import { TuiAutoFocus } from '@taiga-ui/cdk/directives/auto-focus';
import { NotificationService } from '../../../core/notification.service';

@Component({
  selector: 'app-account-form',
  imports: [ReactiveFormsModule, TuiInput, TuiInputNumber, TuiButton, TuiError, TuiChevron, TuiComboBox, TuiDataListWrapper, TuiFilterByInputPipe, TuiAutoFocus],
  templateUrl: './account-form.html',
  styleUrl: './account-form.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AccountForm {
  private readonly context = inject<TuiDialogContext<Account | null, Account | null>>(POLYMORPHEUS_CONTEXT);
  private readonly accountsState = inject(AccountsState);
  private readonly notifications = inject(NotificationService);

  readonly currencies = this.accountsState.currencies;
  readonly loading = signal(false);
  readonly accountId = signal(this.context.data?.id ?? null);

  readonly form = new FormGroup({
    name: new FormControl<string>(this.context.data?.name ?? '', { nonNullable: true, validators: [Validators.required] }),
    currency: new FormControl<string>(this.context.data?.currency ?? '', { nonNullable: true, validators: [Validators.required] }),
    startBalance: new FormControl<number>(this.context.data?.start_balance ?? 0, { nonNullable: true, validators: [Validators.required] }),
  });

  constructor() {
    // TEMPORARY WORKAROUND (Taiga UI bug): tuiComboBox's internal matching effect
    // nulls out the control on its first run (textfield display text is still
    // empty then), clobbering the initial currency value — re-apply it once the
    // view has finished rendering. Remove once fixed upstream; still present as
    // of @taiga-ui/kit 5.24.0.
    const currency = this.context.data?.currency;
    if (currency) {
      afterNextRender(() => this.form.controls.currency.setValue(currency));
    }
  }

  cancel(): void {
    this.context.completeWith(null);
  }

  async onSubmit() {
    if (this.form.invalid) return;

    try {
      this.loading.set(true);

      const id = this.context.data?.id;
      const { name, currency, startBalance } = this.form.getRawValue();
      const obs = id != null
        ? this.accountsState.update(id, { name, currency, startBalance })
        : this.accountsState.create({ name, currency, startBalance });
      const response = await firstValueFrom(obs);
      this.context.completeWith(response.data);
    } catch (e) {
      this.notifications.showError(e, 'Failed to save account');
    } finally {
      this.loading.set(false);
    }
  }
}
