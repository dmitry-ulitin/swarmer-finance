import { Injectable, computed, inject, resource } from '@angular/core';
import { firstValueFrom, tap } from 'rxjs';
import { AuthService } from './auth.service';
import { Account } from '../models/account';
import { ApiService } from './api.service';

export interface AccountGroup {
  name: string;
  accounts: (Account & { displayName: string })[];
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
  readonly groupedAccounts = computed<AccountGroup[]>(() => {
    const groups = new Map<string, (Account & { displayName: string })[]>();
    for (const account of this.accounts()) {
      const slash = account.name.indexOf('/');
      const groupName = slash === -1 ? '' : account.name.slice(0, slash);
      const displayName = slash === -1 ? account.name : account.name.slice(slash + 1);
      const entry = groups.get(groupName) ?? [];
      entry.push({ ...account, displayName });
      groups.set(groupName, entry);
    }
    return Array.from(groups.entries()).map(([name, accounts]) => ({ name, accounts }));
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

  create(data: { name: string; currency: string; startBalance: number }) {
    return this.api.createAccount(data).pipe(tap(() => this.resource.reload()));
  }

  update(id: number, data: { name?: string; currency?: string; startBalance?: number }) {
    return this.api.updateAccount(id, data).pipe(tap(() => this.resource.reload()));
  }

  delete(id: number) {
    return this.api.deleteAccount(id).pipe(tap(() => this.resource.reload()));
  }
}
