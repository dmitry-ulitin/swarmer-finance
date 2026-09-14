import { inject, Injectable, INJECTOR } from '@angular/core';
import { TuiDialogService } from '@taiga-ui/core';
import { TUI_CONFIRM } from '@taiga-ui/kit';
import type { TuiConfirmData } from '@taiga-ui/kit';
import { PolymorpheusComponent } from '@taiga-ui/polymorpheus';
import { firstValueFrom } from 'rxjs';
import type { Transaction } from '../../models/transaction';
import type { Account } from '../../models/account';
import { TransactionsState } from '../../core/transactions.state';
import { AccountsState } from '../../core/accounts.state';
import { NotificationService } from '../../core/notification.service';
import { TransactionRequest } from '../../core/api.service';
import { CategoriesState } from '../../core/categories.state';

/**
 * Prefill for "Add transaction". Always defaults to Expense (a
 * debit_account with no credit_account) regardless of the last
 * transaction's type, so the dialog doesn't open on Transfer/Income
 * just because the previous entry happened to be one.
 */
export function buildCreateDefaults(
  lastTransaction: Transaction | undefined,
  preferredAccount: Account | undefined,
  today: string,
): Partial<Transaction> | null {
  if (lastTransaction) {
    const debitAccount = lastTransaction.debit_account ?? lastTransaction.credit_account;
    return {
      ...lastTransaction,
      id: undefined,
      created_at: undefined,
      description: '',
      payee: '',
      category: null,
      debit: undefined,
      credit: undefined,
      date: today,
      debit_account: debitAccount,
      credit_account: null,
    };
  }
  if (!preferredAccount) return null;
  return { date: today, debit_account: preferredAccount, currency: preferredAccount.currency };
}

@Injectable({ providedIn: 'root' })
export class TransactionDialogService {
  private readonly dialogs = inject(TuiDialogService);
  private readonly injector = inject(INJECTOR);
  private readonly transactionsState = inject(TransactionsState);
  private readonly accountState = inject(AccountsState);
  private readonly categoriesState = inject(CategoriesState);
  private readonly notifications = inject(NotificationService);

  async openCreate(): Promise<Transaction | null> {
    const { TransactionForm } = await import('./transaction-form/transaction-form');
    const lastTransaction = this.transactionsState.transactions()[0];
    if (!lastTransaction && this.accountState.accounts().length < 1) {
      this.notifications.showError('No accounts available');
      return null;
    }
    const preferredAccount = this.accountState.accounts().find(a => a.id === this.transactionsState.selectedAccountIds()[0]) || this.accountState.accounts()[0];
    const defaultData = buildCreateDefaults(lastTransaction, preferredAccount, new Date().toISOString().split('T')[0])!;
    try {
      const result = await firstValueFrom(
        this.dialogs.open<TransactionRequest | null>(
          new PolymorpheusComponent(TransactionForm, this.injector),
          { data: defaultData, label: 'Add Transaction', size: 's' }
        ),
        { defaultValue: null }
      );
      if (!result) return null;
      const response = await firstValueFrom(this.transactionsState.create(result));
      return response.data;
    } catch (e) {
      this.notifications.showError(e, 'Failed to create transaction');
      return null;
    }
  }

  async openEdit(transaction: Transaction): Promise<Transaction | null> {
    try {
      const { TransactionForm } = await import('./transaction-form/transaction-form');
      const result = await firstValueFrom(
        this.dialogs.open<TransactionRequest | null>(
          new PolymorpheusComponent(TransactionForm, this.injector),
          { data: transaction, label: 'Edit Transaction', size: 's' }
        ),
        { defaultValue: null }
      );
      if (!result) return null;
      const response = await firstValueFrom(this.transactionsState.update(transaction.id, result));
      this.notifications.showSuccess('Transaction updated successfully');
      return response.data;
    } catch (e) {
      this.notifications.showError(e, 'Failed to update transaction');
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
      this.notifications.showError(e, 'Failed to delete transaction');
      return false;
    }
  }
}
