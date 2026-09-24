import { inject, Injectable, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../core/api.service';
import { AccountsState } from '../../core/accounts.state';
import { TransactionsState } from '../../core/transactions.state';
import { NotificationService } from '../../core/notification.service';
import type { Account, AccountSyncResult } from '../../models/account';

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export function describeSync(r: AccountSyncResult): string {
  const parts: string[] = [];
  if (r.added) parts.push(`${plural(r.added, 'transaction', 'transactions')} added`);
  if (r.merged) parts.push(`${r.merged} merged into ${r.merged === 1 ? 'a transfer' : 'transfers'}`);
  if (r.fees) parts.push(plural(r.fees, 'fee', 'fees'));
  return parts.length > 0 ? parts.join(', ') : 'Already up to date';
}

/**
 * Runs a blockchain sync for one account. The busy set lives here rather
 * than in the tree node: reloading accounts re-renders the tree, and the
 * node would lose a local flag mid-sync.
 */
@Injectable({ providedIn: 'root' })
export class AccountSyncService {
  private readonly api = inject(ApiService);
  private readonly accounts = inject(AccountsState);
  private readonly transactions = inject(TransactionsState);
  private readonly notifications = inject(NotificationService);

  private readonly busy = signal<ReadonlySet<number>>(new Set());
  readonly syncing = this.busy.asReadonly();

  async sync(account: Account): Promise<void> {
    if (this.busy().has(account.id)) return;
    this.busy.update(s => new Set(s).add(account.id));
    try {
      const response = await firstValueFrom(this.api.syncAccount(account.id));
      // Sync reports only counts; balances move too, hence both lists.
      this.transactions.reload();
      this.accounts.reload();
      this.notifications.showSuccess(describeSync(response.data!));
    } catch (e) {
      this.notifications.showError(e, `Failed to sync ${account.name}`);
    } finally {
      this.busy.update(s => {
        const next = new Set(s);
        next.delete(account.id);
        return next;
      });
    }
  }
}
