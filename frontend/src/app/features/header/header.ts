import { ChangeDetectionStrategy, Component, inject, INJECTOR } from '@angular/core';
import { AuthService } from '../../core/auth.service';
import { TuiButton, tuiDialog } from '@taiga-ui/core';
import { TransactionDialogService } from '../transactions/transaction-dialog.service';

@Component({
  selector: 'app-header',
  imports: [TuiButton],
  templateUrl: './header.html',
  styleUrl: './header.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Header {
  authService = inject(AuthService);
  private readonly injector = inject(INJECTOR);
  private readonly transactionDialogs = inject(TransactionDialogService);

  async categories() {
    const {Categories} = await import('../categories/categories');
    tuiDialog(Categories, {
      injector: this.injector,
      label: 'Categories',
      size: 'l',
    })().subscribe();
  }

  addTransaction(): void {
    this.transactionDialogs.openCreate();
  }

  async accounts() {
    const {Accounts} = await import('../accounts/accounts');
    tuiDialog(Accounts, {
      injector: this.injector,
      label: 'Accounts',
      size: 'm',
    })().subscribe();
  }
}
