import { AccessLevel, Account, accessLevelOf } from '../models/account';

export interface AccountLeafItem {
  kind: 'account';
  account: Account & { displayName: string };
}

export interface AccountGroupItem {
  kind: 'group';
  displayName: string;
  fullPath: string;
  /**
   * Identifies the group, where `fullPath` only names it: two groups can share
   * a path and differ in level or owner. Use this for expand state and @for
   * tracking, never for deriving account names.
   */
  key: string;
  /** Shared by every account in the group — it is part of the grouping key. */
  access_level: AccessLevel;
  children: AccountTreeItem[];
}

export type AccountTreeItem = AccountLeafItem | AccountGroupItem;

/** The root items reachable on one access level, rendered as one block. */
export interface AccountSection {
  access_level: AccessLevel;
  items: AccountTreeItem[];
}

// An account the backend did not label is one the user owns outright.
const levelOf = (item: AccountTreeItem): AccessLevel =>
  item.kind === 'account' ? accessLevelOf(item.account) : item.access_level;

function itemName(item: AccountTreeItem): string {
  return item.kind === 'account' ? item.account.displayName : item.displayName;
}

function compareByName(a: AccountTreeItem, b: AccountTreeItem): number {
  return itemName(a).localeCompare(itemName(b), undefined, { sensitivity: 'base' });
}

function sortItems(items: AccountTreeItem[]): void {
  items.sort(compareByName);
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
    let key = item.key;
    while (children.length === 1 && children[0].kind === 'group') {
      displayName = `${displayName}/${children[0].displayName}`;
      fullPath = children[0].fullPath;
      key = children[0].key;
      children = children[0].children;
    }
    if (children.length === 1 && children[0].kind === 'account') {
      const leaf = children[0];
      const accountDisplayName = ancestorPath === undefined
        ? leaf.account.name
        : leaf.account.name.slice(ancestorPath.length + 1);
      return { kind: 'account', account: { ...leaf.account, displayName: accountDisplayName } };
    }
    return {
      kind: 'group',
      displayName,
      fullPath,
      key,
      access_level: item.access_level,
      children: collapseSingleChildGroups(children, fullPath),
    };
  });
}

// Groups are keyed by access level and owner as well as by name, so accounts
// the user reaches on different terms never merge into one group: a personal
// "Bank" and a "Bank" shared by Bob stay two rows with one path between them.
// The separator is a NUL so no owner name or path can contain it and make two
// different groups collide on one key.
const groupKey = (level: number, owner: string, path: string) =>
  `${level}\u0000${owner}\u0000${path}`;

/**
 * Labels an item with its owner, for the top level only: below level 3 an
 * account is someone else's, and the row has to say whose. Nested rows inherit
 * the label from the group heading them, so repeating it there adds noise.
 */
function withOwnerSuffix(item: AccountTreeItem): AccountTreeItem {
  if (levelOf(item) >= 3) return item;
  if (item.kind === 'group') {
    const owner = ownerOf(item);
    return owner ? { ...item, displayName: `${item.displayName} (${owner})` } : item;
  }
  const owner = item.account.owner_name;
  return owner
    ? { ...item, account: { ...item.account, displayName: `${item.account.displayName} (${owner})` } }
    : item;
}

// Every account under a group shares one owner — it is part of the group key.
function ownerOf(group: AccountGroupItem): string | undefined {
  for (const child of group.children) {
    if (child.kind === 'account') return child.account.owner_name;
    const owner = ownerOf(child);
    if (owner !== undefined) return owner;
  }
  return undefined;
}

export function buildAccountTree(accounts: Account[]): AccountTreeItem[] {
  const groupMap = new Map<string, AccountGroupItem>();
  const roots: AccountTreeItem[] = [];

  function getOrCreateGroup(segments: string[], level: AccessLevel, owner: string): AccountGroupItem {
    const path = segments.join('/');
    const key = groupKey(level, owner, path);
    const existing = groupMap.get(key);
    if (existing) return existing;
    const group: AccountGroupItem = {
      kind: 'group',
      displayName: segments[segments.length - 1],
      fullPath: path,
      key,
      access_level: level,
      children: [],
    };
    groupMap.set(key, group);
    if (segments.length === 1) {
      roots.push(group);
    } else {
      getOrCreateGroup(segments.slice(0, -1), level, owner).children.push(group);
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
      getOrCreateGroup(groupSegments, accessLevelOf(account), account.owner_name ?? '').children.push(leaf);
    }
  }

  sortItems(roots);
  // Own accounts first, then by name. Only the root is ranked by level: within
  // a group every account already shares one.
  roots.sort((a, b) => levelOf(b) - levelOf(a) || compareByName(a, b));
  // After collapsing, so an account lifted to the top level is labelled too.
  return collapseSingleChildGroups(roots).map(withOwnerSuffix);
}

/**
 * Splits the root items into one section per access level, dropping empty
 * ones. The tree is already sorted by level descending, so sections come out
 * 4, 3, 2, 1 in that order without re-sorting.
 */
export function groupIntoSections(items: AccountTreeItem[]): AccountSection[] {
  const sections: AccountSection[] = [];
  for (const item of items) {
    const level = levelOf(item);
    const last = sections[sections.length - 1];
    if (last?.access_level === level) last.items.push(item);
    else sections.push({ access_level: level, items: [item] });
  }
  return sections;
}

export function collectAccountIds(group: AccountGroupItem): number[] {
  const ids: number[] = [];
  for (const item of group.children) {
    if (item.kind === 'account') ids.push(item.account.id);
    else ids.push(...collectAccountIds(item));
  }
  return ids;
}

/** One chip of the active account filter: a single account or a whole group. */
export interface AccountChip {
  key: string;
  label: string;
  ids: number[];
}

/**
 * Turns the selected account ids into chips, in tree order. A group whose
 * accounts are all selected becomes one chip; a partially selected one is
 * broken down into its children. Labels are full paths, since a leaf's
 * displayName is relative to its group and means little outside the tree.
 */
export function selectedAccountChips(items: AccountTreeItem[], selected: ReadonlySet<number>): AccountChip[] {
  const chips: AccountChip[] = [];
  for (const item of items) {
    const owner = levelOf(item) < 3
      ? (item.kind === 'account' ? item.account.owner_name : ownerOf(item))
      : undefined;
    const suffix = owner ? ` (${owner})` : '';
    if (item.kind === 'account') {
      if (selected.has(item.account.id)) {
        chips.push({ key: `a${item.account.id}`, label: item.account.name + suffix, ids: [item.account.id] });
      }
      continue;
    }
    const ids = collectAccountIds(item);
    if (ids.every(id => selected.has(id))) {
      chips.push({ key: item.key, label: item.fullPath + suffix, ids });
    } else {
      chips.push(...selectedAccountChips(item.children, selected));
    }
  }
  return chips;
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
