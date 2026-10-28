import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { TransactionsState } from '../../core/transactions.state';
import { AccountsState } from '../../core/accounts.state';
import { PageReload } from '../../core/page-reload';
import { TransactionList } from '../transactions/transaction-list';
import { AccountList } from '../accounts/account-list/account-list';
import { FiltersBar } from '../filters-bar/filters-bar';
import { CategorySummaryPanel } from '../category-summary/category-summary';

@Component({
  selector: 'app-dashboard',
  imports: [FiltersBar, TransactionList, AccountList, CategorySummaryPanel],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Dashboard {
  constructor() {
    // Entering the dashboard refreshes the list. Done here, before the
    // children exist, so the summary's first load already sees the bumped
    // revision instead of loading once more for it.
    const transactions = inject(TransactionsState);
    transactions.reload();
    const accounts = inject(AccountsState);
    inject(PageReload).register('Reload transactions', () => {
      accounts.reload();
      transactions.reload();
    });
  }
}
