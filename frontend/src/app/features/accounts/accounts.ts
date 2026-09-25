import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MoneyPipe } from '../../core/money.pipe';
import { AccountsState } from '../../core/accounts.state';
import { Account } from '../../models/account';
import { AuthService } from '../../core/auth.service';
import { TuiButton, TuiLoader } from '@taiga-ui/core';
import { AccountDialogService } from './account-dialog.service';

@Component({
  selector: 'app-accounts',
  imports: [TuiButton, TuiLoader, MoneyPipe],
  templateUrl: './accounts.html',
  styleUrl: './accounts.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Accounts {
  readonly accountsState = inject(AccountsState);
  protected readonly auth = inject(AuthService);
  private readonly accountDialogs = inject(AccountDialogService);

  readonly selectedId = signal<number | null>(null);
  readonly selectedAccount = computed(() => {
    const id = this.selectedId();
    if (id === null) return null;
    return this.accountsState.visibleAccounts().find(a => a.id === id) ?? null;
  });

  setAsSelected(account: Account) {
    this.selectedId.set(account.id);
  }

  async openCreateDialog(): Promise<void> {
    const account = await this.accountDialogs.openCreate();
    if (account !== null) {
      this.selectedId.set(account.id);
    }
  }

  async openEditDialog(): Promise<void> {
    const account = this.selectedAccount();
    if (!account) return;
    await this.accountDialogs.openEdit(account);
  }

  async openDeleteDialog(): Promise<void> {
    const account = this.selectedAccount();
    if (!account) return;
    if (await this.accountDialogs.openDelete(account)) {
      this.selectedId.set(null);
    }
  }

  showUserBalance(account: Account): boolean {
    const user = this.auth.user();
    return account.user_balance !== null && !!user && user.currency !== account.currency;
  }
}
