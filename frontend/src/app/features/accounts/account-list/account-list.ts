import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { AccountsState } from '../../../core/accounts.state';
import { AccountListStore } from './account-list.store';
import { AccountTreeNode } from './account-tree-node/account-tree-node';
import { TransactionsState } from '../../../core/transactions.state';
import { MoneyPipe } from '../../../core/money.pipe';

@Component({
  selector: 'app-account-list',
  imports: [AccountTreeNode, MoneyPipe],
  providers: [AccountListStore],
  templateUrl: './account-list.html',
  styleUrl: './account-list.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AccountList {
  protected readonly state = inject(AccountsState);
  protected readonly transactions = inject(TransactionsState);
}
