import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { AccountsState } from '../../core/accounts.state';
import { Account } from '../../models/account';
import { TuiButton, TuiLoader } from '@taiga-ui/core';
import { AccountDialogService } from './account-dialog.service';
import { firstValueFrom } from 'rxjs';

@Component({
  selector: 'app-accounts',
  imports: [TuiButton, TuiLoader, DecimalPipe],
  templateUrl: './accounts.html',
  styleUrl: './accounts.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Accounts {
  readonly accountsState = inject(AccountsState);
  private readonly accountDialogs = inject(AccountDialogService);

  readonly selectedId = signal<number | null>(null);
  readonly selectedAccount = computed(() => {
    const id = this.selectedId();
    if (id === null) return null;
    return this.accountsState.accounts().find(a => a.id === id) ?? null;
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
    const confirmed = await this.accountDialogs.openDelete(account);
    if (confirmed) {
      await firstValueFrom(this.accountsState.delete(account.id));
      this.selectedId.set(null);
    }
  }
}
