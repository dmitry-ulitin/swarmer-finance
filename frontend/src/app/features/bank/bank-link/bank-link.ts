import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { TuiButton, TuiDataList, TuiLoader, TuiTextfield, type TuiDialogContext } from '@taiga-ui/core';
import { TuiChevron, TuiSelect } from '@taiga-ui/kit';
import { POLYMORPHEUS_CONTEXT } from '@taiga-ui/polymorpheus';
import { firstValueFrom } from 'rxjs';
import { AccountsState } from '../../../core/accounts.state';
import { ApiService } from '../../../core/api.service';
import { NotificationService } from '../../../core/notification.service';
import type { Account } from '../../../models/account';
import type { BankConnection } from '../../../models/bank';

interface LinkOption {
  key: string;
  label: string;
  connectionId: number;
  uid: string;
  disabled: boolean;
}

/** Links an app account to one of the bank accounts of the user's connections. */
@Component({
  selector: 'app-bank-link',
  imports: [ReactiveFormsModule, TuiButton, TuiChevron, TuiDataList, TuiLoader, TuiSelect, TuiTextfield],
  templateUrl: './bank-link.html',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BankLink {
  private readonly api = inject(ApiService);
  private readonly accounts = inject(AccountsState);
  private readonly notifications = inject(NotificationService);
  private readonly context = inject<TuiDialogContext<boolean, Account>>(POLYMORPHEUS_CONTEXT);

  readonly account = this.context.data;
  readonly loading = signal(true);
  readonly busy = signal(false);
  readonly connections = signal<BankConnection[]>([]);
  readonly control = new FormControl('', { nonNullable: true });
  private readonly value = toSignal(this.control.valueChanges, { initialValue: '' });

  /** Every bank account of the user's connections; other currencies than the account's are disabled. */
  readonly options = computed<LinkOption[]>(() =>
    this.connections().flatMap(c => c.accounts.map(a => ({
      key: `${c.id}:${a.uid}`,
      label: `${c.aspspName} · ${a.name || a.iban || a.uid} · ${a.currency === 'XXX' ? 'multi-currency' : a.currency}`,
      connectionId: c.id,
      uid: a.uid,
      disabled: a.currency !== 'XXX' && a.currency !== this.account.currency,
    })))
  );
  readonly selected = computed(() => {
    const key = this.value();
    return this.options().find(o => o.key === key) ?? null;
  });
  readonly stringify = (key: string): string => this.options().find(o => o.key === key)?.label ?? '';
  readonly linked = !!this.account.bank_link;

  constructor() {
    void this.load();
  }

  private async load(): Promise<void> {
    try {
      this.connections.set((await firstValueFrom(this.api.getBankConnections())).data ?? []);
      const link = this.account.bank_link;
      const current = link && this.options().find(o => o.connectionId === link.connectionId && o.uid === link.uid);
      if (current) this.control.setValue(current.key);
    } catch (e) {
      this.notifications.showError(e, 'Failed to load bank accounts');
    } finally {
      this.loading.set(false);
    }
  }

  async save(): Promise<void> {
    const option = this.selected();
    if (!option || option.disabled) return;
    await this.run(
      () => firstValueFrom(this.api.linkBankAccount(this.account.id, option.connectionId, option.uid)),
      'Failed to link the bank account'
    );
  }

  async unlink(): Promise<void> {
    await this.run(() => firstValueFrom(this.api.unlinkBankAccount(this.account.id)), 'Failed to unlink the bank account');
  }

  cancel(): void {
    this.context.completeWith(false);
  }

  private async run(action: () => Promise<unknown>, failure: string): Promise<void> {
    try {
      this.busy.set(true);
      await action();
      this.accounts.reload();
      this.context.completeWith(true);
    } catch (e) {
      this.notifications.showError(e, failure);
    } finally {
      this.busy.set(false);
    }
  }
}
