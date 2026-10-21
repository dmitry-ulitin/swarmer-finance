import { ChangeDetectionStrategy, Component, computed, inject, input, signal } from '@angular/core';
import { MoneyPipe } from '../../../../core/money.pipe';
import { AccountGroupItem, AccountLeafItem, AccountTreeItem, collectAccountIds, collectAccounts, collectUserBalance, sumByCurrency } from '../../../../core/account-tree';
import { amountsHint } from '../../../../core/money-hint';
import { AccountListStore } from '../account-list.store';
import { TransactionsState } from '../../../../core/transactions.state';
import { AuthService } from '../../../../core/auth.service';
import { TuiExpand, TuiButton, TuiHint } from '@taiga-ui/core';
import { TuiHovered } from '@taiga-ui/cdk';
import { Account, accessLevelOf } from '../../../../models/account';
import { ImportDialogService } from '../../../import/import-dialog.service';
import { AccountSyncService } from '../../account-sync.service';

@Component({
  selector: 'app-account-tree-node',
  imports: [AccountTreeNode, MoneyPipe, TuiExpand, TuiButton, TuiHint, TuiHovered],
  providers: [MoneyPipe],
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
  private readonly importDialog = inject(ImportDialogService);
  protected readonly sync = inject(AccountSyncService);
  private readonly money = inject(MoneyPipe);
  protected readonly hovered = signal(false);

  protected readonly nodeAccountIds = computed(() => {
    const item = this.item();
    return item.kind === 'group' ? collectAccountIds(item) : [item.account.id];
  });

  protected readonly groupBalance = computed(() => {
    const item = this.item();
    return item.kind === 'group' ? collectUserBalance(item) : null;
  });

  /** An account's balance in the user's currency, when it is kept in another. */
  protected readonly accountHint = computed(() => {
    const item = this.item();
    const user = this.auth.user();
    if (item.kind !== 'account' || !user) return null;
    const { currency, user_balance } = item.account;
    if (currency === user.currency || user_balance === null) return null;
    return this.money.transform(user_balance, user.currency, user.currency_scale);
  });

  /** The unconverted balances behind a group's total. */
  protected readonly groupHint = computed(() => {
    const item = this.item();
    const user = this.auth.user();
    if (item.kind !== 'group' || !user) return null;
    return amountsHint(this.money, sumByCurrency(collectAccounts(item)), user.currency);
  });

  protected asGroup(item: AccountTreeItem): AccountGroupItem {
    return item as AccountGroupItem;
  }

  protected asAccount(item: AccountTreeItem): AccountLeafItem {
    return item as AccountLeafItem;
  }

  protected readonly indent = computed(() => `calc(0.25rem + ${this.depth()}rem)`);

  /** Importing and syncing take write access. */
  protected canWrite(account: Account): boolean {
    return accessLevelOf(account) >= 2;
  }

  protected onImport(account: Account): void {
    void this.importDialog.open(account);
  }

  protected onSync(account: Account): void {
    void this.sync.sync(account);
  }
}
