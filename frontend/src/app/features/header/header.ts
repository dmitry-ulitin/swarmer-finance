import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { AuthService } from '../../core/auth.service';
import { TuiButton } from '@taiga-ui/core';
import { CategoryDialogService } from '../categories/category-dialog.service';
import { AccountDialogService } from '../accounts/account-dialog.service';
import { TransactionsState } from '../../core/transactions.state';
import { TransactionDialogService } from '../transactions/transaction-dialog.service';
import { AccountsState } from '../../core/accounts.state';

@Component({
  selector: 'app-header',
  imports: [TuiButton],
  templateUrl: './header.html',
  styleUrl: './header.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Header {
  readonly authService = inject(AuthService);
  readonly accountState = inject(AccountsState);
  private readonly transactionsState = inject(TransactionsState);
  private readonly categoryDialogs = inject(CategoryDialogService);
  private readonly accountDialogs = inject(AccountDialogService);
  private readonly transactionDialogs = inject(TransactionDialogService);

  readonly selectedTransaction = this.transactionsState.selectedTransaction;

  categories(): void {
    this.categoryDialogs.openManager();
  }

  reload(): void {
    this.transactionsState.reload();
  }

  accounts(): void {
    this.accountDialogs.openManager();
  }

  addTransaction(): void {
    this.transactionDialogs.openCreate();
  }

  editTransaction(): void {
    const t = this.selectedTransaction();
    if (t) this.transactionDialogs.openEdit(t);
  }

  deleteTransaction(): void {
    const t = this.selectedTransaction();
    if (t) this.transactionDialogs.openDelete(t);
  }
}
