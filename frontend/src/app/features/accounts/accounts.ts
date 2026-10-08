import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { MoneyPipe } from '../../core/money.pipe';
import { AccountsState } from '../../core/accounts.state';
import { AccessLevel, Account, accessLevelOf } from '../../models/account';
import { TuiButton, TuiDataList, TuiDropdown, TuiLoader } from '@taiga-ui/core';
import { TuiChevron } from '@taiga-ui/kit';
import { AccountDialogService } from './account-dialog.service';

@Component({
  selector: 'app-accounts',
  imports: [TuiButton, TuiChevron, TuiDataList, TuiDropdown, TuiLoader, MoneyPipe],
  templateUrl: './accounts.html',
  styleUrl: './accounts.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Accounts {
  readonly accountsState = inject(AccountsState);
  private readonly accountDialogs = inject(AccountDialogService);

  /**
   * Blocks per access level, highest first, sorted by name within, as in the
   * side list; below admin an account is someone else's and says whose.
   */
  readonly sections = computed(() => {
    const sorted = [...this.accountsState.visibleAccounts()].sort((a, b) =>
      accessLevelOf(b) - accessLevelOf(a) || a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
    const sections: { access_level: AccessLevel; accounts: (Account & { displayName: string })[] }[] = [];
    for (const account of sorted) {
      const level = accessLevelOf(account);
      const displayName = level < 3 && account.owner_name
        ? `${account.name} (${account.owner_name})`
        : account.name;
      const last = sections[sections.length - 1];
      if (last?.access_level === level) last.accounts.push({ ...account, displayName });
      else sections.push({ access_level: level, accounts: [{ ...account, displayName }] });
    }
    return sections;
  });

  readonly selectedId = signal<number | null>(null);
  readonly selectedAccount = computed(() => {
    const id = this.selectedId();
    if (id === null) return null;
    return this.accountsState.visibleAccounts().find(a => a.id === id) ?? null;
  });
  /** Owner or admin. */
  readonly canPurge = computed(() => {
    const account = this.selectedAccount();
    return !!account && accessLevelOf(account) >= 3;
  });

  setAsSelected(account: Account) {
    this.selectedId.set(account.id);
  }

  async openCreateDialog(): Promise<void> {
    const account = await this.accountDialogs.openCreate();
    if (account !== null) {
      this.selectedId.set(account.id);
    }
  }

  async openEditDialog(): Promise<void> {
    const account = this.selectedAccount();
    if (!account) return;
    await this.accountDialogs.openEdit(account);
  }

  async openDeleteDialog(): Promise<void> {
    const account = this.selectedAccount();
    if (!account) return;
    if (await this.accountDialogs.openDelete(account)) {
      this.selectedId.set(null);
    }
  }

  async openPurgeDialog(): Promise<void> {
    const account = this.selectedAccount();
    if (!account) return;
    await this.accountDialogs.openPurgeTransactions(account);
  }

  async openDeleteWithTransactionsDialog(): Promise<void> {
    const account = this.selectedAccount();
    if (!account) return;
    if (await this.accountDialogs.openDeleteWithTransactions(account)) {
      this.selectedId.set(null);
    }
  }
}
