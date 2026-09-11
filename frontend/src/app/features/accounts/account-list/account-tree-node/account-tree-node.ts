import { ChangeDetectionStrategy, Component, computed, inject, input } from '@angular/core';
import { AccountNode, collectAccountIds, collectUserBalance } from '../../../../core/accounts.state';
import { AccountListStore } from '../account-list.store';
import { TransactionsState } from '../../../../core/transactions.state';
import { AuthService } from '../../../../core/auth.service';

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
  private readonly auth = inject(AuthService);

  protected readonly nodeAccountIds = computed(() => collectAccountIds(this.node()));
  protected readonly groupBalance = computed(() => this.formatUserBalance(collectUserBalance(this.node())));

  protected get indent(): string {
    return `calc(0.75rem + ${this.depth()}rem)`;
  }

  protected formatUserBalance(value: number | null): string {
    if (value === null) return '';
    const user = this.auth.user();
    if (!user) return '';
    return this.formatAmount(value, user.currency, user.currency_scale);
  }

  private formatAmount(value: number, currency: string, scale: number): string {
    try {
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency,
        minimumFractionDigits: scale,
        maximumFractionDigits: scale,
      }).format(value);
    } catch {
      return value.toLocaleString(undefined, { minimumFractionDigits: scale, maximumFractionDigits: scale });
    }
  }
}
