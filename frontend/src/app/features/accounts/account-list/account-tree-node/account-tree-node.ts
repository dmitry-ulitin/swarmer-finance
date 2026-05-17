import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { AccountNode, collectAccountIds } from '../../../../core/accounts.state';
import { AccountListStore } from '../account-list.store';
import { TransactionsState } from '../../../../core/transactions.state';

@Component({
  selector: 'app-account-tree-node',
  imports: [AccountTreeNode],
  templateUrl: './account-tree-node.html',
  styleUrl: './account-tree-node.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AccountTreeNode {
  readonly node = input.required<AccountNode>();
  readonly depth = input<number>(0);

  protected readonly store = inject(AccountListStore);
  protected readonly transactions = inject(TransactionsState);

  protected readonly nodeAccountIds = computed(() => collectAccountIds(this.node()));

  protected get indent(): string {
    return `${this.depth() * 1}rem`;
  }
}
