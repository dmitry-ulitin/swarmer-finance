import { Injectable, computed, inject, resource } from '@angular/core';
import { firstValueFrom, tap } from 'rxjs';
import { AuthService } from './auth.service';
import { Account } from '../models/account';
import { ApiService } from './api.service';

export interface BalanceSummary {
  currency: string;
  scale: number;
  total: number;
  incomplete: boolean;
}

export interface AccountLeafItem {
  kind: 'account';
  account: Account & { displayName: string };
}

export interface AccountGroupItem {
  kind: 'group';
  displayName: string;
  fullPath: string;
  children: AccountTreeItem[];
}

export type AccountTreeItem = AccountLeafItem | AccountGroupItem;

function itemName(item: AccountTreeItem): string {
  return item.kind === 'account' ? item.account.displayName : item.displayName;
}

function sortItems(items: AccountTreeItem[]): void {
  items.sort((a, b) => itemName(a).localeCompare(itemName(b), undefined, { sensitivity: 'base' }));
  for (const item of items) {
    if (item.kind === 'group') sortItems(item.children);
  }
}

// Groups with fewer than 2 children collapse: a lone child is spliced into
// the parent's level. When the lone child is itself a group, the two group
// names merge (e.g. "Bank" + "Savings" -> "Bank/Savings") so the path isn't lost.
// When the lone child is an account, its displayName is recomputed relative
// to the surviving ancestor group (or the account's full name, at the root)
// so the collapsed group segments aren't silently dropped from the label.
// `ancestorPath` is the fullPath of the nearest ancestor group that will
// still exist in the final tree (undefined at the root).
function collapseSingleChildGroups(items: AccountTreeItem[], ancestorPath?: string): AccountTreeItem[] {
  return items.map(item => {
    if (item.kind !== 'group') return item;
    let children = item.children;
    let displayName = item.displayName;
    let fullPath = item.fullPath;
    while (children.length === 1 && children[0].kind === 'group') {
      displayName = `${displayName}/${children[0].displayName}`;
      fullPath = children[0].fullPath;
      children = children[0].children;
    }
    if (children.length === 1 && children[0].kind === 'account') {
      const leaf = children[0];
      const accountDisplayName = ancestorPath === undefined
        ? leaf.account.name
        : leaf.account.name.slice(ancestorPath.length + 1);
      return { kind: 'account', account: { ...leaf.account, displayName: accountDisplayName } };
    }
    return { kind: 'group', displayName, fullPath, children: collapseSingleChildGroups(children, fullPath) };
  });
}

export function buildAccountTree(accounts: Account[]): AccountTreeItem[] {
  const groupMap = new Map<string, AccountGroupItem>();
  const roots: AccountTreeItem[] = [];

  function getOrCreateGroup(segments: string[]): AccountGroupItem {
    const path = segments.join('/');
    if (groupMap.has(path)) return groupMap.get(path)!;
    const group: AccountGroupItem = { kind: 'group', displayName: segments[segments.length - 1], fullPath: path, children: [] };
    groupMap.set(path, group);
    if (segments.length === 1) {
      roots.push(group);
    } else {
      getOrCreateGroup(segments.slice(0, -1)).children.push(group);
    }
    return group;
  }

  for (const account of accounts) {
    const segments = account.name.split('/');
    const displayName = segments[segments.length - 1];
    const groupSegments = segments.slice(0, -1);
    const leaf: AccountLeafItem = { kind: 'account', account: { ...account, displayName } };

    if (groupSegments.length === 0) {
      roots.push(leaf);
    } else {
      getOrCreateGroup(groupSegments).children.push(leaf);
    }
  }

  sortItems(roots);
  return collapseSingleChildGroups(roots);
}

export function collectAccountIds(group: AccountGroupItem): number[] {
  const ids: number[] = [];
  for (const item of group.children) {
    if (item.kind === 'account') ids.push(item.account.id);
    else ids.push(...collectAccountIds(item));
  }
  return ids;
}

// Sums user_balance across all accounts in a subtree. Returns null if any
// account's user_balance is null (rate unavailable), rather than silently
// showing a total that's missing part of its data.
export function collectUserBalance(group: AccountGroupItem): number | null {
  let total = 0;
  for (const item of group.children) {
    if (item.kind === 'account') {
      if (item.account.user_balance === null) return null;
      total += item.account.user_balance;
    } else {
      const subtotal = collectUserBalance(item);
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

  readonly accounts = computed(() => this.resource.value() ?? []);
  // Excludes soft-deleted accounts — for display in the accounts list UI.
  // Use `accounts` instead where deleted accounts must remain selectable
  // (e.g. editing an existing transaction that references one).
  readonly visibleAccounts = computed(() => this.accounts().filter(a => !a.deleted));
  readonly groupedAccounts = computed<AccountTreeItem[]>(() => buildAccountTree(this.visibleAccounts()));
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
