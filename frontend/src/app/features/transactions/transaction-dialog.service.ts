import { inject, Injectable, INJECTOR } from '@angular/core';
import { TuiDialogService, TuiNotificationService } from '@taiga-ui/core';
import { TUI_CONFIRM } from '@taiga-ui/kit';
import type { TuiConfirmData } from '@taiga-ui/kit';
import { PolymorpheusComponent } from '@taiga-ui/polymorpheus';
import { firstValueFrom } from 'rxjs';
import type { Transaction } from '../../models/transaction';
import { TransactionsState } from '../../core/transactions.state';
import { AccountsState } from '../../core/accounts.state';
import type { TransactionFormResult } from './transaction-form/transaction-form';

@Injectable({ providedIn: 'root' })
export class TransactionDialogService {
  private readonly dialogs = inject(TuiDialogService);
  private readonly injector = inject(INJECTOR);
  private readonly transactionsState = inject(TransactionsState);
  private readonly accountState = inject(AccountsState);
  private readonly notifications = inject(TuiNotificationService);

  async openCreate(): Promise<Transaction | null> {
    const { TransactionForm } = await import('./transaction-form/transaction-form');
    const lastTransaction = this.transactionsState.transactions()[0];
    let defaultData: Partial<Transaction> = { date: new Date().toISOString().split('T')[0] };
    if (lastTransaction) {
      defaultData = { ...lastTransaction, id: undefined, created_at: undefined, description: '', payee: '', category: null, debit: undefined, credit: undefined };
    } else if (this.accountState.accounts().length < 1) {
      return null;
    } else {
      const account = this.accountState.accounts().find(a => a.id === this.transactionsState.selectedAccountIds()[0]) || this.accountState.accounts()[0];
      defaultData = { ...defaultData, debit_account: account, currency: account.currency };
    }
    try {
      const result = await firstValueFrom(
        this.dialogs.open<TransactionFormResult | null>(
          new PolymorpheusComponent(TransactionForm, this.injector),
          { data: defaultData, label: 'Add Transaction', size: 's' }
        ),
        { defaultValue: null }
      );
      if (!result) return null;
      const response = await firstValueFrom(this.transactionsState.create(result.request));
      return response.data;
    } catch (e) {
      this.notifications.open('Failed to create transaction', { label: 'error' });
      return null;
    }
  }

  async openEdit(transaction: Transaction): Promise<Transaction | null> {
    try {
      const { TransactionForm } = await import('./transaction-form/transaction-form');
      const result = await firstValueFrom(
        this.dialogs.open<TransactionFormResult | null>(
          new PolymorpheusComponent(TransactionForm, this.injector),
          { data: transaction, label: 'Edit Transaction', size: 's' }
        ),
        { defaultValue: null }
      );
      if (!result) return null;
      const response = await firstValueFrom(this.transactionsState.update(transaction.id, result.request));
      this.notifications.open('Transaction updated successfully', { label: 'success' });
      return response.data;
    } catch (e) {
      this.notifications.open('Failed to update transaction', { label: 'error' });
      return null;
    }
  }

  async openDelete(transaction: Transaction): Promise<boolean> {
    try {
      const description = transaction.description || transaction.payee || `#${transaction.id}`;
      const confirmed = await firstValueFrom(
        this.dialogs.open<boolean>(TUI_CONFIRM, {
          label: 'Delete Transaction',
          size: 's',
          data: { content: `Delete "${description}"?`, yes: 'Delete', no: 'Cancel' } satisfies TuiConfirmData,
        }),
        { defaultValue: false }
      );
      if (!confirmed) return false;
      await firstValueFrom(this.transactionsState.delete(transaction.id));
      return true;
    } catch (e) {
      this.notifications.open('Failed to delete transaction', { label: 'error' });
      return false;
    }
  }
}
