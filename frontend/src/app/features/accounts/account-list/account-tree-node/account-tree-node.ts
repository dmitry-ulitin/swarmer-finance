import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { CurrencyPipe } from '@angular/common';
import { AccountNode, collectAccountIds, collectUserBalance } from '../../../../core/accounts.state';
import { AccountListStore } from '../account-list.store';
import { TransactionsState } from '../../../../core/transactions.state';
import { AuthService } from '../../../../core/auth.service';

@Component({
  selector: 'app-account-tree-node',
  imports: [AccountTreeNode, CurrencyPipe],
  templateUrl: './account-tree-node.html',
  styleUrl: './account-tree-node.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AccountTreeNode {
  readonly node = input.required<AccountNode>();
  readonly depth = input<number>(0);

  protected readonly store = inject(AccountListStore);
  protected readonly transactions = inject(TransactionsState);
  protected readonly auth = inject(AuthService);

  protected readonly nodeAccountIds = computed(() => collectAccountIds(this.node()));
  protected readonly groupBalance = computed(() => collectUserBalance(this.node()));

  protected get indent(): string {
    return `calc(0.75rem + ${this.depth()}rem)`;
  }
}
