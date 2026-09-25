import { inject, Injectable, INJECTOR } from '@angular/core';
import { TUI_CONFIRM, TuiConfirmData } from '@taiga-ui/kit';
import { tuiDialog, TuiDialogService } from '@taiga-ui/core';
import { PolymorpheusComponent } from '@taiga-ui/polymorpheus';
import { firstValueFrom } from 'rxjs';
import type { Account, AccountPurgeResult } from '../../models/account';
import { AuthService } from '../../core/auth.service';
import { AccountsState } from '../../core/accounts.state';
import { TransactionsState } from '../../core/transactions.state';
import { NotificationService } from '../../core/notification.service';

@Injectable({ providedIn: 'root' })
export class AccountDialogService {
  private readonly dialogs = inject(TuiDialogService);
  private readonly auth = inject(AuthService);
  private readonly injector = inject(INJECTOR);
  private readonly accountsState = inject(AccountsState);
  private readonly transactionsState = inject(TransactionsState);
  private readonly notifications = inject(NotificationService);

  async openManager(): Promise<void> {
    try {
      const { Accounts } = await import('./accounts');
      await firstValueFrom(
        tuiDialog(Accounts, { injector: this.injector, label: 'Accounts', size: 'm' })(),
        { defaultValue: null }
      );
    } catch (e) {
      this.notifications.showError(e, 'Failed to open accounts');
    }
  }

  async openCreate(): Promise<Account | null> {
    try {
      const { AccountForm } = await import('./account-form/account-form');
      return await firstValueFrom(
        this.dialogs.open<Account | null>(
          new PolymorpheusComponent(AccountForm, this.injector),
          { data: { currency: this.auth.user()?.currency || 'EUR' }, label: 'Add Account', size: 's' }
        ),
        { defaultValue: null }
      );
    } catch (e) {
      this.notifications.showError(e, 'Failed to open account form');
      return null;
    }
  }

  async openEdit(account: Account): Promise<void> {
    try {
      const { AccountForm } = await import('./account-form/account-form');
      await firstValueFrom(
        this.dialogs.open<Account | null>(
          new PolymorpheusComponent(AccountForm, this.injector),
          { data: account, label: 'Edit Account', size: 's' }
        ),
        { defaultValue: null }
      );
    } catch (e) {
      this.notifications.showError(e, 'Failed to open account form');
    }
  }

  async openDelete(account: Account): Promise<boolean> {
    const data: TuiConfirmData = {
      content: `Delete "${account.name}"?`,
      yes: 'Delete',
      no: 'Cancel',
    };
    try {
      const confirmed = await firstValueFrom(
        this.dialogs.open<boolean>(TUI_CONFIRM, { label: 'Delete Account', size: 's', data }),
        { defaultValue: false }
      );
      if (!confirmed) return false;
      await firstValueFrom(this.accountsState.delete(account.id));
      return true;
    } catch (e) {
      this.notifications.showError(e, 'Failed to delete account');
      return false;
    }
  }

  /** Deletes every transaction of the account; transfers stay on their other account. */
  async openPurgeTransactions(account: Account): Promise<boolean> {
    const data: TuiConfirmData = {
      content: `Delete all transactions of "${account.name}"? Transfers stay on their other account `
        + 'as uncategorized income or expense. This cannot be undone.',
      yes: 'Delete transactions',
      no: 'Cancel',
    };
    try {
      if (!await this.confirm('Delete All Transactions', data)) return false;
      const response = await firstValueFrom(this.accountsState.purgeTransactions(account.id));
      this.transactionsState.reload();
      this.notifications.showSuccess(describePurge(response.data!));
      return true;
    } catch (e) {
      this.notifications.showError(e, 'Failed to delete transactions');
      return false;
    }
  }

  /** Deletes the account for good, with its transactions, as openPurgeTransactions does. */
  async openDeleteWithTransactions(account: Account): Promise<boolean> {
    const data: TuiConfirmData = {
      content: `Delete "${account.name}" and all its transactions? Transfers stay on their other account `
        + 'as uncategorized income or expense. This cannot be undone.',
      yes: 'Delete account',
      no: 'Cancel',
    };
    try {
      if (!await this.confirm('Delete Account with Transactions', data)) return false;
      const response = await firstValueFrom(this.accountsState.deleteWithTransactions(account.id));
      this.transactionsState.reload();
      this.notifications.showSuccess(`Account deleted, ${describePurge(response.data!)}`);
      return true;
    } catch (e) {
      this.notifications.showError(e, 'Failed to delete account');
      return false;
    }
  }

  private confirm(label: string, data: TuiConfirmData): Promise<boolean> {
    return firstValueFrom(
      this.dialogs.open<boolean>(TUI_CONFIRM, { label, size: 's', data }),
      { defaultValue: false }
    );
  }
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

function describePurge({ deleted, detached }: AccountPurgeResult): string {
  const text = `${plural(deleted, 'transaction')} deleted`;
  return detached > 0 ? `${text}, ${plural(detached, 'transfer')} kept as uncategorized` : text;
}
