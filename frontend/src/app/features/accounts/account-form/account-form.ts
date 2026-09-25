import { afterNextRender, ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { toSignal, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { TuiButton, TuiDialogService, TuiError, TuiFilterByInputPipe, TuiInput, TuiNumberFormat } from '@taiga-ui/core';
import { TUI_CONFIRM, type TuiConfirmData, TuiChevron, TuiComboBox, TuiDataListWrapper, TuiInputNumber, TuiSelect, TuiStringifyContentPipe } from '@taiga-ui/kit';
import { POLYMORPHEUS_CONTEXT } from '@taiga-ui/polymorpheus';
import type { TuiDialogContext } from '@taiga-ui/core';
import { AccountsState } from '../../../core/accounts.state';
import { SYNCED_CHAINS, type Account, type AccountPayload, type AccountType } from '../../../models/account';
import { firstValueFrom, merge, startWith } from 'rxjs';
import { TuiAutoFocus } from '@taiga-ui/cdk/directives/auto-focus';
import { NotificationService } from '../../../core/notification.service';
import { currencyScale } from '../../../core/currency-scale';

const ACCOUNT_TYPES: readonly AccountType[] = ['cash', 'bank', 'crypto'];

const TYPE_LABELS: Record<AccountType, string> = {
  cash: 'Cash',
  bank: 'Bank',
  crypto: 'Crypto',
};

@Component({
  selector: 'app-account-form',
  imports: [ReactiveFormsModule, TuiInput, TuiInputNumber, TuiButton, TuiError, TuiChevron, TuiComboBox, TuiSelect, TuiDataListWrapper, TuiFilterByInputPipe, TuiAutoFocus, TuiStringifyContentPipe, TuiNumberFormat],
  templateUrl: './account-form.html',
  styleUrl: './account-form.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AccountForm {
  // `openCreate` passes only `{ currency }`, so the context data is a partial.
  private readonly context = inject<TuiDialogContext<Account | null, Partial<Account> | null>>(POLYMORPHEUS_CONTEXT);
  private readonly accountsState = inject(AccountsState);
  private readonly notifications = inject(NotificationService);
  private readonly dialogs = inject(TuiDialogService);

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

  readonly blockchains: readonly string[] = ['', ...Object.keys(SYNCED_CHAINS)];
  readonly blockchainLabel = (chain: string): string => chain || 'None';
  private readonly currency = toSignal(this.form.controls.currency.valueChanges, {
    initialValue: this.form.controls.currency.value,
  });
  /** The backend stores the account at its currency's scale. */
  readonly balancePrecision = computed(() => currencyScale(this.currency() ?? ''));
  readonly balanceQuantum = computed(() => 1 / Math.pow(10, this.balancePrecision()));

  /** Mirrors backend isTracked: transactions will come from the chain. */
  readonly tracked = signal(false);
  /** Currencies the chosen chain syncs; null while the account is not tracked. */
  private readonly trackedCurrencies = signal<readonly string[] | null>(null);
  readonly currencyOptions = computed(() => this.trackedCurrencies() ?? this.currencies());

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

    // Applied synchronously with every change to the deciding controls, so a
    // patchValue and the lock can never disagree. A synced wallet's balance
    // comes only from the chain: it starts at 0 in one of the chain's currencies,
    // and the backend rejects anything else.
    const c = this.form.controls;
    merge(c.type.valueChanges, c.address.valueChanges, c.blockchain.valueChanges)
      .pipe(startWith(null), takeUntilDestroyed())
      .subscribe(() => this.applyTrackedLock());
  }

  private applyTrackedLock(): void {
    const { type, address, blockchain, startBalance, currency } = this.form.controls;
    const tracked = type.value === 'crypto' && address.value.trim() !== '' && blockchain.value in SYNCED_CHAINS;
    const allowed = tracked ? SYNCED_CHAINS[blockchain.value] : null;
    this.tracked.set(tracked);
    this.trackedCurrencies.set(allowed);
    if (allowed) {
      startBalance.setValue(0);
      startBalance.disable();
      if (!allowed.includes(currency.value ?? '')) currency.setValue(allowed[0]);
      // A chain with one asset leaves nothing to choose.
      if (allowed.length === 1) currency.disable();
      else currency.enable();
    } else {
      startBalance.enable();
      currency.enable();
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

  /** An existing account starts syncing: its rows get reconciled with the chain. */
  private switchesSyncOn(): boolean {
    const data = this.context.data;
    return data?.id != null && !data.tracked && this.tracked();
  }

  private confirmSync(): Promise<boolean> {
    const data: TuiConfirmData = {
      content: 'Existing transactions of this account will be reconciled with the blockchain now: '
        + 'matching ones keep their category and description, the rest are removed; '
        + 'transfers to accounts not synced from a blockchain are left to those accounts. The start balance becomes 0.',
      yes: 'Enable sync',
      no: 'Cancel',
    };
    return firstValueFrom(
      this.dialogs.open<boolean>(TUI_CONFIRM, { label: 'Sync from blockchain', size: 's', data }),
      { defaultValue: false }
    );
  }

  async onSubmit() {
    if (this.form.invalid) return;
    if (this.switchesSyncOn() && !await this.confirmSync()) return;

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
