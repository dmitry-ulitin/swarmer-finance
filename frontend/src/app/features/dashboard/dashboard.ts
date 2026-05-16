import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { TransactionList } from '../transactions/transaction-list';
import { AccountList } from '../accounts/account-list/account-list';
import { TransactionsState } from '../../core/transactions.state';

@Component({
  selector: 'app-dashboard',
  imports: [TransactionList, AccountList],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Dashboard {
  private readonly transactionsState = inject(TransactionsState);

  onAccountFilter(ids: number[]): void {
    this.transactionsState.setFilters(ids.length ? { account: ids } : {});
  }
}
