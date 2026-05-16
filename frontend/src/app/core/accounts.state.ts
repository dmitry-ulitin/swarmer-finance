import { Injectable, computed, inject, resource } from '@angular/core';
import { firstValueFrom, tap } from 'rxjs';
import { AuthService } from './auth.service';
import { Account } from '../models/account';
import { ApiService } from './api.service';

export interface AccountNode {
  name: string;
  fullPath: string;
  accounts: (Account & { displayName: string })[];
  children: AccountNode[];
}

function getOrCreateNode(nodes: AccountNode[], segment: string, fullPath: string): AccountNode {
  let node = nodes.find(n => n.name === segment);
  if (!node) {
    node = { name: segment, fullPath, accounts: [], children: [] };
    nodes.push(node);
  }
  return node;
}

export function buildAccountTree(accounts: Account[]): AccountNode[] {
  const roots: AccountNode[] = [];
  for (const account of accounts) {
    const segments = account.name.split('/');
    const displayName = segments[segments.length - 1];
    const groupSegments = segments.slice(0, -1);
    if (groupSegments.length === 0) {
      let ungrouped = roots.find(n => n.name === '');
      if (!ungrouped) {
        ungrouped = { name: '', fullPath: '', accounts: [], children: [] };
        roots.push(ungrouped);
      }
      ungrouped.accounts.push({ ...account, displayName });
    } else {
      let current = roots;
      let path = '';
      for (const segment of groupSegments) {
        path = path ? `${path}/${segment}` : segment;
        const node = getOrCreateNode(current, segment, path);
        current = node.children;
      }
      const parent = findNode(roots, groupSegments);
      if (parent) parent.accounts.push({ ...account, displayName });
    }
  }
  return roots;
}

function findNode(nodes: AccountNode[], segments: string[]): AccountNode | null {
  let current = nodes;
  let found: AccountNode | null = null;
  for (const segment of segments) {
    found = current.find(n => n.name === segment) ?? null;
    if (!found) return null;
    current = found.children;
  }
  return found;
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
  readonly groupedAccounts = computed<AccountNode[]>(() => buildAccountTree(this.accounts()));
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
