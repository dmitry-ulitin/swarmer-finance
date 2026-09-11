import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { AccountsState } from '../../../core/accounts.state';
import { AccountListStore } from './account-list.store';
import { AccountTreeNode } from './account-tree-node/account-tree-node';
import { TransactionsState } from '../../../core/transactions.state';

@Component({
  selector: 'app-account-list',
  imports: [AccountTreeNode],
  providers: [AccountListStore],
  templateUrl: './account-list.html',
  styleUrl: './account-list.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AccountList {
  protected readonly state = inject(AccountsState);
  protected readonly transactions = inject(TransactionsState);

  protected readonly totalBalance = computed(() => {
    const summary = this.state.summary();
    if (!summary || summary.incomplete) return '';
    try {
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency: summary.currency,
        minimumFractionDigits: summary.scale,
        maximumFractionDigits: summary.scale,
      }).format(summary.total);
    } catch {
      return summary.total
        .toLocaleString(undefined, { minimumFractionDigits: summary.scale, maximumFractionDigits: summary.scale });
    }
  });
}
