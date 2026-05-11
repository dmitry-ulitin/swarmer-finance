import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { AuthService } from '../../core/auth.service';
import { TuiButton } from '@taiga-ui/core';
import { CategoryDialogService } from '../categories/category-dialog.service';
import { AccountDialogService } from '../accounts/account-dialog.service';
import { TransactionsState } from '../../core/transactions.state';

@Component({
  selector: 'app-header',
  imports: [TuiButton],
  templateUrl: './header.html',
  styleUrl: './header.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Header {
  authService = inject(AuthService);
  private readonly transactionsState = inject(TransactionsState);
  private readonly categoryDialogs = inject(CategoryDialogService);
  private readonly accountDialogs = inject(AccountDialogService);

  categories(): void {
    this.categoryDialogs.openManager();
  }

  reload(): void {
    this.transactionsState.reload();
  }

  accounts(): void {
    this.accountDialogs.openManager();
  }
}
