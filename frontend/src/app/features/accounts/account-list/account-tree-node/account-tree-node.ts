import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { CurrencyPipe } from '@angular/common';
import { AccountGroupItem, AccountLeafItem, AccountTreeItem, collectAccountIds, collectUserBalance } from '../../../../core/accounts.state';
import { AccountListStore } from '../account-list.store';
import { TransactionsState } from '../../../../core/transactions.state';
import { AuthService } from '../../../../core/auth.service';
import { TuiExpand } from '@taiga-ui/core/components/expand';

@Component({
  selector: 'app-account-tree-node',
  imports: [AccountTreeNode, CurrencyPipe, TuiExpand],
  templateUrl: './account-tree-node.html',
  styleUrl: './account-tree-node.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AccountTreeNode {
  readonly item = input.required<AccountTreeItem>();
  readonly depth = input<number>(0);

  protected readonly store = inject(AccountListStore);
  protected readonly transactions = inject(TransactionsState);
  protected readonly auth = inject(AuthService);

  protected readonly nodeAccountIds = computed(() => {
    const item = this.item();
    return item.kind === 'group' ? collectAccountIds(item) : [item.account.id];
  });
  protected readonly groupBalance = computed(() => {
    const item = this.item();
    return item.kind === 'group' ? collectUserBalance(item) : null;
  });

  protected asGroup(item: AccountTreeItem): AccountGroupItem {
    return item as AccountGroupItem;
  }

  protected asAccount(item: AccountTreeItem): AccountLeafItem {
    return item as AccountLeafItem;
  }

  protected get indent(): string {
    return `calc(0.75rem + ${this.depth()}rem)`;
  }
}
