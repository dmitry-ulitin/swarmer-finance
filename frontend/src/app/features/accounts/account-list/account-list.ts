import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { TuiHint } from '@taiga-ui/core';
import { AccountsState } from '../../../core/accounts.state';
import { AccountListStore } from './account-list.store';
import { AccountTreeNode } from './account-tree-node/account-tree-node';
import { TransactionsState } from '../../../core/transactions.state';
import { MoneyPipe } from '../../../core/money.pipe';
import { AccountDialogService } from '../account-dialog.service';
import { sumByCurrency } from '../../../core/account-tree';
import { amountsHint } from '../../../core/money-hint';

@Component({
  selector: 'app-account-list',
  imports: [AccountTreeNode, MoneyPipe, TuiHint],
  providers: [AccountListStore, MoneyPipe],
  templateUrl: './account-list.html',
  styleUrl: './account-list.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AccountList {
  protected readonly state = inject(AccountsState);
  protected readonly transactions = inject(TransactionsState);
  private readonly accountDialogs = inject(AccountDialogService);
  private readonly money = inject(MoneyPipe);

  /** The unconverted balances behind the total. */
  protected readonly totalHint = computed(() => {
    const summary = this.state.summary();
    if (!summary) return null;
    return amountsHint(this.money, sumByCurrency(this.state.visibleAccounts()), summary.currency);
  });

  protected openCreateDialog(): void {
    this.accountDialogs.openCreate();
  }
}
