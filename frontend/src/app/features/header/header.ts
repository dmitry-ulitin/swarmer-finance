import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { AuthService } from '../../core/auth.service';
import { TuiButton } from '@taiga-ui/core';
import { TransactionDialogService } from '../transactions/transaction-dialog.service';
import { CategoryDialogService } from '../categories/category-dialog.service';
import { AccountDialogService } from '../accounts/account-dialog.service';

@Component({
  selector: 'app-header',
  imports: [TuiButton],
  templateUrl: './header.html',
  styleUrl: './header.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Header {
  authService = inject(AuthService);
  private readonly transactionDialogs = inject(TransactionDialogService);
  private readonly categoryDialogs = inject(CategoryDialogService);
  private readonly accountDialogs = inject(AccountDialogService);

  categories(): void {
    this.categoryDialogs.openManager();
  }

  addTransaction(): void {
    this.transactionDialogs.openCreate();
  }

  accounts(): void {
    this.accountDialogs.openManager();
  }
}
