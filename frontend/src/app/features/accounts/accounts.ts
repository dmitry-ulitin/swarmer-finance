import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { AccountsState } from '../../core/accounts.state';
import { Account } from '../../models/account';
import { AuthService } from '../../core/auth.service';
import { TuiButton, TuiLoader } from '@taiga-ui/core';
import { AccountDialogService } from './account-dialog.service';
import { firstValueFrom } from 'rxjs';

@Component({
  selector: 'app-accounts',
  imports: [TuiButton, TuiLoader],
  templateUrl: './accounts.html',
  styleUrl: './accounts.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Accounts {
  readonly accountsState = inject(AccountsState);
  private readonly accountDialogs = inject(AccountDialogService);
  private readonly auth = inject(AuthService);

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
    const confirmed = await this.accountDialogs.openDelete(account);
    if (confirmed) {
      await firstValueFrom(this.accountsState.delete(account.id));
      this.selectedId.set(null);
    }
  }

  formatBalance(account: Account): string {
    return this.formatAmount(account.balance, account.currency, account.scale);
  }

  formatUserBalance(account: Account): string {
    if (account.user_balance === null) return '';
    const user = this.auth.user();
    if (!user || user.currency === account.currency) return '';
    return this.formatAmount(account.user_balance, user.currency, user.currency_scale);
  }

  private formatAmount(value: number, currency: string, scale: number): string {
    try {
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency,
        minimumFractionDigits: scale,
        maximumFractionDigits: scale,
      }).format(value);
    } catch {
      return value.toLocaleString(undefined, { minimumFractionDigits: scale, maximumFractionDigits: scale });
    }
  }
}
