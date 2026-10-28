import { afterNextRender, ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { toSignal, takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { TuiButton, TuiCheckbox, TuiDataList, TuiDialogService, TuiError, TuiFilterByInputPipe, TuiInput, TuiLabel, TuiNumberFormat } from '@taiga-ui/core';
import { TUI_CONFIRM, type TuiConfirmData, TuiChevron, TuiComboBox, TuiDataListWrapper, TuiInputNumber, TuiSelect, TuiStringifyContentPipe } from '@taiga-ui/kit';
import { POLYMORPHEUS_CONTEXT } from '@taiga-ui/polymorpheus';
import type { TuiDialogContext } from '@taiga-ui/core';
import { AccountsState } from '../../../core/accounts.state';
import { SYNCED_CHAINS, TYPE_LABELS, type Account, type AccountPayload, type AccountType } from '../../../models/account';
import { firstValueFrom, merge, startWith } from 'rxjs';
import { TuiAutoFocus } from '@taiga-ui/cdk/directives/auto-focus';
import { NotificationService } from '../../../core/notification.service';
import { currencyScale } from '../../../core/currency-scale';
import { ApiService } from '../../../core/api.service';
import type { BankConnection } from '../../../models/bank';

const ACCOUNT_TYPES: readonly AccountType[] = ['cash', 'bank', 'crypto', 'investment', 'property', 'deposit', 'debt'];

/** A bank account the app account can load from; key '' is "not linked". */
interface BankOption {
  key: string;
  label: string;
  link: { connectionId: number; uid: string } | null;
  /** The bank account's currency; 'XXX' is multi-currency. */
  currency: string | null;
}

const bankLabel = (bank: string, account: string, currency: string): string =>
  `${bank} · ${account} · ${currency === 'XXX' ? 'multi-currency' : currency}`;

/** The combo box takes free text; the backend wants an upper-case code. */
const normalizeCurrency = (currency: string): string => currency.trim().toUpperCase();

@Component({
  selector: 'app-account-form',
  imports: [ReactiveFormsModule, TuiInput, TuiInputNumber, TuiButton, TuiError, TuiChevron, TuiComboBox, TuiSelect, TuiDataListWrapper, TuiFilterByInputPipe, TuiAutoFocus, TuiStringifyContentPipe, TuiNumberFormat, TuiDataList, TuiCheckbox, TuiLabel],
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
  private readonly api = inject(ApiService);

  readonly currencies = this.accountsState.currencies;
  readonly accountTypes = ACCOUNT_TYPES;
  readonly typeLabel = (type: AccountType): string => TYPE_LABELS[type];
  readonly loading = signal(false);
  readonly isEdit = this.context.data?.id != null;

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
    bankAccount: new FormControl<string>(this.linkKey(this.context.data?.bank_link), { nonNullable: true }),
    // A new account is the user's own, which counts toward net worth by default.
    inNetWorth: new FormControl<boolean>(this.context.data?.in_net_worth ?? true, { nonNullable: true }),
  });

  readonly type = toSignal(this.form.controls.type.valueChanges, {
    initialValue: this.form.controls.type.value,
  });

  readonly blockchains: readonly string[] = ['', ...Object.keys(SYNCED_CHAINS)];
  readonly blockchainLabel = (chain: string): string => chain || 'None';
  private readonly currencyValue = toSignal(this.form.controls.currency.valueChanges, {
    initialValue: this.form.controls.currency.value,
  });
  private readonly currency = computed(() => normalizeCurrency(this.currencyValue() ?? ''));
  /** The backend stores the account at its currency's scale. */
  readonly balancePrecision = computed(() => currencyScale(this.currency()));
  readonly balanceQuantum = computed(() => 1 / Math.pow(10, this.balancePrecision()));

  /** The backend refuses a new start balance once the account has transactions. */
  readonly hasTransactions = this.context.data?.last_transaction_date != null;

  /** Mirrors backend isTracked: transactions will come from the chain. */
  readonly tracked = signal(false);
  /** Currencies the chosen chain syncs; null while the account is not tracked. */
  private readonly trackedCurrencies = signal<readonly string[] | null>(null);
  readonly currencyOptions = computed(() => this.trackedCurrencies() ?? this.currencies());

  private readonly bankConnections = signal<BankConnection[]>([]);
  /**
   * "Not linked", every bank account of the user's own connections, and the
   * current link when it is not among them (another member's connection, or
   * a uid the bank dropped on a reconnect), so saving keeps it.
   */
  readonly bankOptions = computed<BankOption[]>(() => {
    const own = this.bankConnections().flatMap(c => c.accounts.map(a => ({
      key: this.linkKey({ connectionId: c.id, uid: a.uid }),
      label: bankLabel(c.aspspName, a.name || a.iban || a.uid, a.currency),
      link: { connectionId: c.id, uid: a.uid },
      currency: a.currency,
    })));
    const current = this.context.data?.bank_link;
    const extra = current && !own.some(o => o.key === this.linkKey(current))
      ? [{
          key: this.linkKey(current),
          label: bankLabel(current.aspspName, current.accountName || current.iban || current.uid, current.currency)
            + (current.status === 'unmapped' ? ' (relink)' : ''),
          link: { connectionId: current.connectionId, uid: current.uid },
          currency: current.currency,
        }]
      : [];
    return [{ key: '', label: 'Not linked', link: null, currency: null }, ...extra, ...own];
  });
  readonly bankLabelOf = (key: string): string => this.bankOptions().find(o => o.key === key)?.label ?? '';
  private readonly bankAccount = toSignal(this.form.controls.bankAccount.valueChanges, {
    initialValue: this.form.controls.bankAccount.value,
  });
  /** Mirrors the backend check: a single-currency bank account must match the account. */
  readonly fitsBank = (key: string): boolean => {
    const currency = this.bankOptions().find(o => o.key === key)?.currency;
    return !currency || currency === 'XXX' || currency === this.currency();
  };
  readonly bankMismatch = computed(() => this.type() === 'bank' && !this.fitsBank(this.bankAccount()));

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

    void this.loadBankConnections();
  }

  private linkKey(link: { connectionId: number; uid: string } | null | undefined): string {
    return link ? `${link.connectionId}:${link.uid}` : '';
  }

  /** Without bank sync on the server (503) or any connection, the field just stays hidden. */
  private async loadBankConnections(): Promise<void> {
    try {
      this.bankConnections.set((await firstValueFrom(this.api.getBankConnections())).data ?? []);
    } catch {
      this.bankConnections.set([]);
    }
  }

  private applyTrackedLock(): void {
    const { type, address, blockchain, startBalance, currency } = this.form.controls;
    const tracked = type.value === 'crypto' && address.value.trim() !== '' && blockchain.value in SYNCED_CHAINS;
    const allowed = tracked ? SYNCED_CHAINS[blockchain.value] : null;
    // The currency is part of the wallet: once the account is tracked, the
    // backend refuses another one for the same address and chain after its
    // first sync, so the form does not offer it at all.
    const data = this.context.data;
    const wasTracked = this.tracked();
    const sameTrackedWallet = !!data?.tracked
      && address.value.trim() === (data.settings as { address?: string })?.address
      && blockchain.value === (data.settings as { blockchain?: string })?.blockchain;
    this.tracked.set(tracked);
    this.trackedCurrencies.set(allowed);
    if (allowed) {
      startBalance.setValue(0);
      startBalance.disable();
      if (!allowed.includes(currency.value ?? '')) currency.setValue(allowed[0]);
      // Nothing to choose on a one-asset chain or for a wallet already tracked.
      if (allowed.length === 1 || sameTrackedWallet) currency.disable();
      else currency.enable();
    } else {
      if (wasTracked) {
        // Undo what the lock forced: back to the stored values.
        startBalance.setValue(data?.start_balance ?? 0);
        currency.setValue(data?.currency ?? '');
      }
      if (this.hasTransactions) startBalance.disable();
      else startBalance.enable();
      currency.enable();
    }
  }

  // Assembles the request body from the controls belonging to the selected
  // type. Blank optional fields are omitted rather than sent as '', so the
  // stored settings hold only keys the user actually filled in.
  buildPayload(): AccountPayload {
    const raw = this.form.getRawValue();
    const base = { name: raw.name, currency: normalizeCurrency(raw.currency), startBalance: raw.startBalance, inNetWorth: raw.inNetWorth };
    const clean = (value: string): string | undefined => {
      const trimmed = value.trim();
      return trimmed === '' ? undefined : trimmed;
    };

    switch (raw.type) {
      case 'bank': {
        const accountNumber = clean(raw.accountNumber);
        const bankLink = this.bankOptions().find(o => o.key === raw.bankAccount)?.link ?? null;
        return { ...base, type: 'bank', settings: accountNumber === undefined ? {} : { accountNumber }, bankLink };
      }
      case 'crypto': {
        const address = clean(raw.address);
        const blockchain = clean(raw.blockchain);
        return {
          ...base,
          ...this.unlinkIfLinked(),
          type: 'crypto',
          settings: {
            ...(address === undefined ? {} : { address }),
            ...(blockchain === undefined ? {} : { blockchain }),
          },
        };
      }
      default:
        return { ...base, ...this.unlinkIfLinked(), type: raw.type, settings: {} };
    }
  }

  /** Leaving the bank type drops the link; the backend refuses a type change otherwise. */
  private unlinkIfLinked(): { bankLink?: null } {
    return this.context.data?.bank_link ? { bankLink: null } : {};
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
    if (this.form.invalid || this.bankMismatch()) return;
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
