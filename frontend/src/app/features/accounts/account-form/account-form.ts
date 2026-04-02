import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { TuiButton, TuiError, TuiTextfield } from '@taiga-ui/core';
import { TuiValidationError } from '@taiga-ui/cdk/classes';
import { POLYMORPHEUS_CONTEXT } from '@taiga-ui/polymorpheus';
import type { TuiDialogContext } from '@taiga-ui/core';
import { AccountsState } from '../../../core/accounts.state';
import type { Account } from '../../../models/account';
import { firstValueFrom } from 'rxjs';

@Component({
  selector: 'app-account-form',
  imports: [ReactiveFormsModule, TuiTextfield, TuiButton, TuiError],
  templateUrl: './account-form.html',
  styleUrl: './account-form.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AccountForm {
  private readonly context = inject<TuiDialogContext<Account | null, Account | null>>(POLYMORPHEUS_CONTEXT);
  private readonly accountsState = inject(AccountsState);

  readonly form = new FormGroup({
    name: new FormControl<string>(this.context.data?.name ?? '', { nonNullable: true, validators: [Validators.required] }),
    currency: new FormControl<string>(this.context.data?.currency ?? '', { nonNullable: true, validators: [Validators.required] }),
    startBalance: new FormControl<number>((this.context.data?.start_balance ?? 0) / 100, { nonNullable: true, validators: [Validators.required] }),
  });

  readonly loading = signal(false);
  readonly accountId = signal(this.context.data?.id ?? null);
  readonly error = signal<TuiValidationError | null>(null);

  async onSubmit() {
    if (this.form.invalid) return;

    try {
      this.loading.set(true);
      this.error.set(null);

      const id = this.context.data?.id;
      const { name, currency } = this.form.getRawValue();
      const startBalance = Math.round(this.form.getRawValue().startBalance * 100);
      const obs = id != null
        ? this.accountsState.update(id, { name, currency, startBalance })
        : this.accountsState.create({ name, currency, startBalance });
      const response = await firstValueFrom(obs);
      this.context.completeWith(response.data);
    } catch {
      this.error.set(new TuiValidationError('Failed to save account'));
    } finally {
      this.loading.set(false);
    }
  }
}
