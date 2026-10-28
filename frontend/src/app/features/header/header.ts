import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { isActive, Router, RouterLink, RouterLinkActive } from '@angular/router';
import { AuthService } from '../../core/auth.service';
import { TuiButton, TuiDataList, TuiDropdown, TuiHint, TuiIcon } from '@taiga-ui/core';
import { CategoryDialogService } from '../categories/category-dialog.service';
import { AccountDialogService } from '../accounts/account-dialog.service';
import { TransactionsState } from '../../core/transactions.state';
import { TransactionDialogService } from '../transactions/transaction-dialog.service';
import { AccountsState } from '../../core/accounts.state';
import { TuiChevron } from '@taiga-ui/kit/directives/chevron';
import { syncedLock } from '../transactions/synced-lock';
import { ImportDialogService } from '../import/import-dialog.service';
import { AccountSyncService } from '../accounts/account-sync.service';
import { accessLevelOf, type Account } from '../../models/account';
import { ChangePasswordDialogService } from '../auth/change-password-dialog.service';
import { ProfileDialogService } from '../profile/profile-dialog.service';
import { NotificationService } from '../../core/notification.service';
import { BankDialogService } from '../bank/bank-dialog.service';
import { PageReload } from '../../core/page-reload';

@Component({
  selector: 'app-header',
  imports: [RouterLink, RouterLinkActive, TuiButton, TuiChevron, TuiDataList, TuiDropdown, TuiHint, TuiIcon],
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
  private readonly profileDialog = inject(ProfileDialogService);
  private readonly notifications = inject(NotificationService);
  private readonly bankDialog = inject(BankDialogService);
  readonly sync = inject(AccountSyncService);
  readonly pageReload = inject(PageReload);
  /** The transaction actions belong to the transactions page only. */
  readonly onTransactions = isActive('/dashboard', inject(Router));

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

  profile(): void {
    void this.profileDialog.open();
  }

  bankConnections(): void {
    void this.bankDialog.openConnections();
  }

  changePassword(): void {
    void this.passwordDialog.open();
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

  /** Valued types, or any account that already has valuations (they survive a type change). */
  hasValuations(account: Account): boolean {
    return account.type === 'investment' || account.type === 'property' || account.type === 'deposit'
      || !!account.last_valuation_date;
  }

  valuationsFiltered(): void {
    const account = this.filteredAccount();
    if (account && this.hasValuations(account)) void this.accountDialogs.openValuations(account);
  }

  toggleNetWorthFiltered(): void {
    const account = this.filteredAccount();
    if (!account) return;
    this.accountState.setInNetWorth(account.id, !account.in_net_worth).subscribe({
      error: e => this.notifications.showError(e, 'Failed to update net worth'),
    });
  }

  importFilteredAccount(): void {
    const account = this.filteredAccount();
    if (account && this.canWriteFiltered()) void this.importDialog.open(account);
  }

  loadFromBankFiltered(): void {
    const account = this.filteredAccount();
    if (account?.bank_link && this.canWriteFiltered()) void this.importDialog.openFromBank(account);
  }

  bankLoadLabel(account: Account): string {
    const status = account.bank_link?.status;
    return status === 'expired' ? 'Load from bank (expired)' : status === 'unmapped' ? 'Load from bank (relink)' : 'Load from bank';
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
