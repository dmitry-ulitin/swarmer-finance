import { afterNextRender, ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { TuiButton, TuiError, TuiFilterByInputPipe, TuiInput } from '@taiga-ui/core';
import { TuiChevron, TuiComboBox, TuiDataListWrapper, TuiInputNumber, TuiSelect, TuiStringifyContentPipe } from '@taiga-ui/kit';
import { POLYMORPHEUS_CONTEXT } from '@taiga-ui/polymorpheus';
import type { TuiDialogContext } from '@taiga-ui/core';
import { AccountsState } from '../../../core/accounts.state';
import type { Account, AccountPayload, AccountType } from '../../../models/account';
import { firstValueFrom } from 'rxjs';
import { TuiAutoFocus } from '@taiga-ui/cdk/directives/auto-focus';
import { NotificationService } from '../../../core/notification.service';

const ACCOUNT_TYPES: readonly AccountType[] = ['cash', 'bank', 'crypto'];

const TYPE_LABELS: Record<AccountType, string> = {
  cash: 'Cash',
  bank: 'Bank',
  crypto: 'Crypto',
};

@Component({
  selector: 'app-account-form',
  imports: [ReactiveFormsModule, TuiInput, TuiInputNumber, TuiButton, TuiError, TuiChevron, TuiComboBox, TuiSelect, TuiDataListWrapper, TuiFilterByInputPipe, TuiAutoFocus, TuiStringifyContentPipe],
  templateUrl: './account-form.html',
  styleUrl: './account-form.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AccountForm {
  // `openCreate` passes only `{ currency }`, so the context data is a partial.
  private readonly context = inject<TuiDialogContext<Account | null, Partial<Account> | null>>(POLYMORPHEUS_CONTEXT);
  private readonly accountsState = inject(AccountsState);
  private readonly notifications = inject(NotificationService);

  readonly currencies = this.accountsState.currencies;
  readonly accountTypes = ACCOUNT_TYPES;
  readonly typeLabel = (type: AccountType): string => TYPE_LABELS[type];
  readonly loading = signal(false);
  readonly accountId = signal(this.context.data?.id ?? null);

  // One group holds the controls for every type. Rebuilding a FormGroup
  // inside a live reactive form breaks formControlName bindings and
  // subscriptions, and the field set is small and fixed, so irrelevant
  // controls are simply hidden and ignored when the payload is assembled.
  readonly form = new FormGroup({
    type: new FormControl<AccountType>(this.context.data?.type ?? 'cash', { nonNullable: true, validators: [Validators.required] }),
    name: new FormControl<string>(this.context.data?.name ?? '', { nonNullable: true, validators: [Validators.required] }),
    currency: new FormControl<string>(this.context.data?.currency ?? '', { nonNullable: true, validators: [Validators.required] }),
    startBalance: new FormControl<number>(this.context.data?.start_balance ?? 0, { nonNullable: true, validators: [Validators.required] }),
    accountNumber: new FormControl<string>('', { nonNullable: true }),
    address: new FormControl<string>('', { nonNullable: true }),
    blockchain: new FormControl<string>('', { nonNullable: true }),
  });

  readonly type = toSignal(this.form.controls.type.valueChanges, {
    initialValue: this.form.controls.type.value,
  });

  constructor() {
    const data = this.context.data;
    if (data?.type === 'bank') {
      this.form.controls.accountNumber.setValue(data.settings?.accountNumber ?? '');
    } else if (data?.type === 'crypto') {
      this.form.controls.address.setValue(data.settings?.address ?? '');
      this.form.controls.blockchain.setValue(data.settings?.blockchain ?? '');
    }

    // TEMPORARY WORKAROUND (Taiga UI bug): tuiComboBox's internal matching effect
    // nulls out the control on its first run (textfield display text is still
    // empty then), clobbering the initial currency value — re-apply it once the
    // view has finished rendering. Remove once fixed upstream; still present as
    // of @taiga-ui/kit 5.24.0. Only the currency combo box is affected; the
    // type selector and the settings inputs need no equivalent.
    const currency = this.context.data?.currency;
    if (currency) {
      afterNextRender(() => this.form.controls.currency.setValue(currency));
    }
  }

  // Assembles the request body from the controls belonging to the selected
  // type. Blank optional fields are omitted rather than sent as '', so the
  // stored settings hold only keys the user actually filled in.
  buildPayload(): AccountPayload {
    const raw = this.form.getRawValue();
    const base = { name: raw.name, currency: raw.currency, startBalance: raw.startBalance };
    const clean = (value: string): string | undefined => {
      const trimmed = value.trim();
      return trimmed === '' ? undefined : trimmed;
    };

    switch (raw.type) {
      case 'bank': {
        const accountNumber = clean(raw.accountNumber);
        return { ...base, type: 'bank', settings: accountNumber === undefined ? {} : { accountNumber } };
      }
      case 'crypto': {
        const address = clean(raw.address);
        const blockchain = clean(raw.blockchain);
        return {
          ...base,
          type: 'crypto',
          settings: {
            ...(address === undefined ? {} : { address }),
            ...(blockchain === undefined ? {} : { blockchain }),
          },
        };
      }
      default:
        return { ...base, type: 'cash', settings: {} };
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
      const payload = this.buildPayload();
      const obs = id != null
        ? this.accountsState.update(id, payload)
        : this.accountsState.create(payload);
      const response = await firstValueFrom(obs);
      this.context.completeWith(response.data);
    } catch (e) {
      this.notifications.showError(e, 'Failed to save account');
    } finally {
      this.loading.set(false);
    }
  }
}
