import { Injectable, computed, inject, resource } from '@angular/core';
import { firstValueFrom, tap } from 'rxjs';
import { AuthService } from './auth.service';
import { Account } from '../models/account';
import { ApiService, BalanceSummary } from './api.service';

export type AccountItem =
  | { kind: 'account'; account: Account & { displayName: string } }
  | { kind: 'group'; node: AccountNode };

export interface AccountNode {
  name: string;
  fullPath: string;
  children: AccountItem[];
}

export function buildAccountTree(accounts: Account[]): AccountNode[] {
  const nodeMap = new Map<string, AccountNode>();
  const roots: AccountNode[] = [];

  function getOrCreate(segments: string[]): AccountNode {
    const path = segments.join('/');
    if (nodeMap.has(path)) return nodeMap.get(path)!;
    const node: AccountNode = { name: segments[segments.length - 1], fullPath: path, children: [] };
    nodeMap.set(path, node);
    if (segments.length === 1) {
      roots.push(node);
    } else {
      const parent = getOrCreate(segments.slice(0, -1));
      parent.children.push({ kind: 'group', node });
    }
    return node;
  }

  for (const account of accounts) {
    const segments = account.name.split('/');
    const displayName = segments[segments.length - 1];
    const groupSegments = segments.slice(0, -1);

    if (groupSegments.length === 0) {
      let ungrouped = nodeMap.get('');
      if (!ungrouped) {
        ungrouped = { name: '', fullPath: '', children: [] };
        nodeMap.set('', ungrouped);
        roots.push(ungrouped);
      }
      ungrouped.children.push({ kind: 'account', account: { ...account, displayName } });
    } else {
      const parent = getOrCreate(groupSegments);
      parent.children.push({ kind: 'account', account: { ...account, displayName } });
    }
  }

  function sortNode(node: AccountNode): void {
    node.children.sort((a, b) => {
      const nameA = a.kind === 'account' ? a.account.displayName : a.node.name;
      const nameB = b.kind === 'account' ? b.account.displayName : b.node.name;
      return nameA.localeCompare(nameB, undefined, { sensitivity: 'base' });
    });
    for (const item of node.children) {
      if (item.kind === 'group') sortNode(item.node);
    }
  }
  for (const root of roots) sortNode(root);
  roots.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  return roots;
}

export function collectAccountIds(node: AccountNode): number[] {
  const ids: number[] = [];
  for (const item of node.children) {
    if (item.kind === 'account') ids.push(item.account.id);
    else ids.push(...collectAccountIds(item.node));
  }
  return ids;
}

// Sums user_balance across all accounts in a subtree. Returns null if any
// account's user_balance is null (rate unavailable), rather than silently
// showing a total that's missing part of its data.
export function collectUserBalance(node: AccountNode): number | null {
  let total = 0;
  for (const item of node.children) {
    if (item.kind === 'account') {
      if (item.account.user_balance === null) return null;
      total += item.account.user_balance;
    } else {
      const subtotal = collectUserBalance(item.node);
      if (subtotal === null) return null;
      total += subtotal;
    }
  }
  return total;
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

  private readonly summaryResource = resource<BalanceSummary | null, boolean>({
    params: () => this.auth.isAuthenticated(),
    loader: async ({ params }) => {
      if (!params) return null;
      const r = await firstValueFrom(this.api.getBalanceSummary());
      return r.data ?? null;
    }
  });

  readonly accounts = computed(() => this.resource.value() ?? []);
  // Excludes soft-deleted accounts — for display in the accounts list UI.
  // Use `accounts` instead where deleted accounts must remain selectable
  // (e.g. editing an existing transaction that references one).
  readonly visibleAccounts = computed(() => this.accounts().filter(a => !a.deleted));
  readonly groupedAccounts = computed<AccountNode[]>(() => buildAccountTree(this.visibleAccounts()));
  readonly summary = computed(() => this.summaryResource.value() ?? null);
  readonly currencies = computed(() => {
    const defaultCurrency = this.auth.user()?.currency;
    const fromAccounts = [...new Set(this.accounts().map(a => a.currency))].sort();
    if (!defaultCurrency) return fromAccounts;
    return [defaultCurrency, ...fromAccounts.filter(c => c !== defaultCurrency)];
  });
  readonly loading = this.resource.isLoading;

  reload() {
    this.resource.reload();
    this.summaryResource.reload();
  }

  create(data: { name: string; currency: string; startBalance: number }) {
    return this.api.createAccount(data).pipe(tap(() => this.reload()));
  }

  update(id: number, data: { name?: string; currency?: string; startBalance?: number }) {
    return this.api.updateAccount(id, data).pipe(tap(() => this.reload()));
  }

  delete(id: number) {
    return this.api.deleteAccount(id).pipe(tap(() => this.reload()));
  }
}
