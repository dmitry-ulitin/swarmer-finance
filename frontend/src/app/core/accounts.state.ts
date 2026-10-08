import { Injectable, computed, inject, resource } from '@angular/core';
import { firstValueFrom, tap } from 'rxjs';
import { AuthService } from './auth.service';
import { Account, AccountPayload } from '../models/account';
import { AccountSection, AccountTreeItem, buildAccountTree, groupIntoSections } from './account-tree';
import { ApiService } from './api.service';

export interface BalanceSummary {
  currency: string;
  scale: number;
  total: number;
  incomplete: boolean;
}

@Injectable({ providedIn: 'root' })
export class AccountsState {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);

  private readonly resource = resource<Account[], boolean>({
    params: () => this.auth.isAuthenticated(),
    loader: async ({ params }) => {
      if (!params) return [];
      const r = await firstValueFrom(this.api.getAccounts());
      return r.data ?? [];
    }
  });

  readonly accounts = computed(() => this.resource.value() ?? []);
  // Excludes soft-deleted accounts — for display in the accounts list UI.
  // Use `accounts` instead where deleted accounts must remain selectable
  // (e.g. editing an existing transaction that references one).
  readonly visibleAccounts = computed(() => this.accounts().filter(a => !a.deleted));
  /** Accounts whose transactions come from the blockchain. */
  readonly trackedIds = computed<ReadonlySet<number>>(
    () => new Set(this.accounts().filter(a => a.tracked).map(a => a.id))
  );
  readonly groupedAccounts = computed<AccountTreeItem[]>(() => buildAccountTree(this.visibleAccounts()));
  readonly accountSections = computed<AccountSection[]>(() => groupIntoSections(this.groupedAccounts()));
  readonly summary = computed<BalanceSummary | null>(() => {
    const user = this.auth.user();
    if (!user) return null;
    const accounts = this.visibleAccounts();
    const incomplete = accounts.some(a => a.user_balance === null);
    const total = incomplete ? 0 : accounts.reduce((sum, a) => sum + (a.user_balance ?? 0), 0);
    return { currency: user.currency, scale: user.currency_scale, total, incomplete };
  });
  readonly currencies = computed(() => {
    const defaultCurrency = this.auth.user()?.currency;
    const fromAccounts = [...new Set(this.accounts().map(a => a.currency))].sort();
    if (!defaultCurrency) return fromAccounts;
    return [defaultCurrency, ...fromAccounts.filter(c => c !== defaultCurrency)];
  });
  readonly loading = this.resource.isLoading;

  reload() {
    this.resource.reload();
  }

  create(data: AccountPayload) {
    return this.api.createAccount(data).pipe(tap(() => this.reload()));
  }

  update(id: number, data: AccountPayload) {
    return this.api.updateAccount(id, data).pipe(tap(() => this.reload()));
  }

  delete(id: number) {
    return this.api.deleteAccount(id).pipe(tap(() => this.reload()));
  }

  purgeTransactions(id: number) {
    return this.api.purgeAccountTransactions(id).pipe(tap(() => this.reload()));
  }

  deleteWithTransactions(id: number) {
    return this.api.deleteAccountWithTransactions(id).pipe(tap(() => this.reload()));
  }
}
