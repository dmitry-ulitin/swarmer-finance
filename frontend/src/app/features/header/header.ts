import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { AuthService } from '../../core/auth.service';
import { TuiButton, TuiDataList, TuiDropdown, TuiIcon } from '@taiga-ui/core';
import { CategoryDialogService } from '../categories/category-dialog.service';
import { AccountDialogService } from '../accounts/account-dialog.service';
import { TransactionsState } from '../../core/transactions.state';
import { TransactionDialogService } from '../transactions/transaction-dialog.service';
import { AccountsState } from '../../core/accounts.state';
import { TuiChevron } from '@taiga-ui/kit/directives/chevron';
import { syncedLock } from '../transactions/synced-lock';
import { ImportDialogService } from '../import/import-dialog.service';
import { AccountSyncService } from '../accounts/account-sync.service';
import { accessLevelOf } from '../../models/account';
import { ChangePasswordDialogService } from '../auth/change-password-dialog.service';

@Component({
  selector: 'app-header',
  imports: [TuiButton, TuiChevron, TuiDataList, TuiDropdown, TuiIcon],
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
  private readonly importDialog = inject(ImportDialogService);
  private readonly passwordDialog = inject(ChangePasswordDialogService);
  readonly sync = inject(AccountSyncService);

  readonly selectedTransaction = this.transactionsState.selectedTransaction;
  /** Changing a transaction takes write access on every account it touches, as the backend requires. */
  readonly canWrite = computed(() => {
    const t = this.selectedTransaction();
    if (!t) return false;
    const accounts = this.accountState.accounts();
    return [t.debit_account, t.credit_account].every(side => {
      if (!side) return true;
      const account = accounts.find(a => a.id === side.id);
      return !!account && accessLevelOf(account) >= 2;
    });
  });
  readonly canDelete = computed(() => {
    const t = this.selectedTransaction();
    return !!t && this.canWrite() && !syncedLock(t, this.accountState.trackedIds()).synced;
  });
  /** The account the filters narrow to, when exactly one is selected. */
  readonly filteredAccount = computed(() => {
    const ids = this.transactionsState.selectedAccountIds();
    if (ids.length !== 1) return null;
    return this.accountState.visibleAccounts().find(a => a.id === ids[0]) ?? null;
  });
  /** Editing an account takes co-owner or owner, as the backend requires. */
  readonly canEditFiltered = computed(() => {
    const account = this.filteredAccount();
    return !!account && accessLevelOf(account) >= 3;
  });
  /** Importing and syncing take write access. */
  readonly canWriteFiltered = computed(() => {
    const account = this.filteredAccount();
    return !!account && accessLevelOf(account) >= 2;
  });

  categories(): void {
    this.categoryDialogs.openManager();
  }

  changePassword(): void {
    void this.passwordDialog.open();
  }

  reload(): void {
    this.accountState.reload();
    this.transactionsState.reload();
  }

  accounts(): void {
    this.accountDialogs.openManager();
  }

  editFilteredAccount(): void {
    const account = this.filteredAccount();
    if (account && this.canEditFiltered()) void this.accountDialogs.openEdit(account);
  }

  shareFilteredAccount(): void {
    const account = this.filteredAccount();
    if (account) void this.accountDialogs.openSharing(account);
  }

  importFilteredAccount(): void {
    const account = this.filteredAccount();
    if (account && this.canWriteFiltered()) void this.importDialog.open(account);
  }

  syncFilteredAccount(): void {
    const account = this.filteredAccount();
    if (account && this.canWriteFiltered()) void this.sync.sync(account);
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
