import { ChangeDetectionStrategy, Component, computed, inject, INJECTOR, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { AccountsState } from '../../core/accounts.state';
import { Account } from '../../models/account';
import { TUI_CONFIRM, TuiConfirmData } from '@taiga-ui/kit';
import { TuiButton, TuiDialogService, TuiLoader } from '@taiga-ui/core';
import { PolymorpheusComponent } from '@taiga-ui/polymorpheus';
import { firstValueFrom } from 'rxjs';

@Component({
  selector: 'app-accounts',
  imports: [TuiButton, TuiLoader, DecimalPipe],
  templateUrl: './accounts.html',
  styleUrl: './accounts.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Accounts {
  readonly accountsState = inject(AccountsState);
  private readonly dialogs = inject(TuiDialogService);
  private readonly injector = inject(INJECTOR);

  readonly selectedId = signal<number | null>(null);
  readonly selectedAccount = computed(() => {
    const id = this.selectedId();
    if (id === null) return null;
    return this.accountsState.accounts().find(a => a.id === id) ?? null;
  });

  setAsSelected(account: Account) {
    this.selectedId.set(account.id);
  }

  async openCreateDialog(): Promise<void> {
    const { AccountForm } = await import('./account-form/account-form');
    const account = await firstValueFrom(this.dialogs.open<Account | null>(
      new PolymorpheusComponent(AccountForm, this.injector),
      { data: null, label: 'Add Account', size: 's' }
    ), { defaultValue: null });
    if (account !== null) {
      this.selectedId.set(account.id);
    }
  }

  async openEditDialog(): Promise<void> {
    const account = this.selectedAccount();
    if (!account) return;
    const { AccountForm } = await import('./account-form/account-form');
    await firstValueFrom(this.dialogs.open<Account | null>(
      new PolymorpheusComponent(AccountForm, this.injector),
      { data: account, label: 'Edit Account', size: 's' }
    ), { defaultValue: null });
  }

  async openDeleteDialog(): Promise<void> {
    const account = this.selectedAccount();
    if (!account) return;
    const data: TuiConfirmData = {
      content: `Delete "${account.name}"?`,
      yes: 'Delete',
      no: 'Cancel',
    };
    const confirmed = await firstValueFrom(
      this.dialogs.open<boolean>(TUI_CONFIRM, { label: 'Delete Account', size: 's', data }),
      { defaultValue: false }
    );
    if (confirmed) {
      await firstValueFrom(this.accountsState.delete(account.id));
      this.selectedId.set(null);
    }
  }
}
