import { describe, it, expect } from 'vitest';
import { buildAccountTree, collectAccountIds, collectUserBalance, AccountGroupItem } from './accounts.state';
import { Account } from '../models/account';

function makeAccount(id: number, name: string): Account {
  return {
    id, user_id: 1, name, currency: 'USD', scale: 2, balance: 0, user_balance: 0,
    start_balance: 0, deleted: false, created_at: '',
    type: 'cash', settings: {},
  };
}

function makeCryptoAccount(id: number, name: string): Account {
  return {
    id, user_id: 1, name, currency: 'BTC', scale: 8, balance: 0, user_balance: 0,
    start_balance: 0, deleted: false, created_at: '',
    type: 'crypto', settings: { address: 'bc1qxy2k', blockchain: 'bitcoin' },
  };
}

describe('account type in the tree', () => {
  it('carries type and settings through to the leaf account', () => {
    const tree = buildAccountTree([makeCryptoAccount(1, 'Crypto/Ledger')]);
    expect(tree[0]).toMatchObject({
      kind: 'account',
      account: { type: 'crypto', settings: { blockchain: 'bitcoin' } },
    });
  });
});

function itemName(item: { kind: 'account' | 'group'; account?: { displayName: string }; displayName?: string }): string {
  return item.kind === 'account' ? item.account!.displayName : item.displayName!;
}

describe('buildAccountTree', () => {
  it('returns empty array for no accounts', () => {
    expect(buildAccountTree([])).toEqual([]);
  });

  it('puts flat accounts directly at the root level, sorted alphabetically', () => {
    const tree = buildAccountTree([makeAccount(1, 'Zebra'), makeAccount(2, 'apple')]);
    expect(tree).toHaveLength(2);
    expect(tree.map(itemName)).toEqual(['apple', 'Zebra']);
    expect(tree[0]).toMatchObject({ kind: 'account', account: { id: 2, displayName: 'apple' } });
  });

  it('interleaves flat accounts and groups alphabetically at the root', () => {
    const tree = buildAccountTree([
      makeAccount(1, 'Zebra'),
      makeAccount(2, 'Bank/Checking'),
      makeAccount(3, 'Bank/Savings'),
      makeAccount(4, 'Middle'),
    ]);
    expect(tree.map(itemName)).toEqual(['Bank', 'Middle', 'Zebra']);
    expect(tree[0].kind).toBe('group');
  });

  it('creates a group node for accounts with "/" in name', () => {
    const tree = buildAccountTree([
      makeAccount(1, 'Bank/Checking'),
      makeAccount(2, 'Bank/Savings'),
    ]);
    expect(tree).toHaveLength(1);
    const group = tree[0] as AccountGroupItem;
    expect(group.kind).toBe('group');
    expect(group.displayName).toBe('Bank');
    expect(group.fullPath).toBe('Bank');
    expect(group.children).toHaveLength(2);
  });

  it('interleaves accounts and sub-groups alphabetically within a group', () => {
    const tree = buildAccountTree([
      makeAccount(1, 'Bank/Zebra'),
      makeAccount(2, 'Bank/AAA-sub/Deep1'),
      makeAccount(3, 'Bank/AAA-sub/Deep2'),
      makeAccount(4, 'Bank/Middle'),
    ]);
    const bank = tree[0] as AccountGroupItem;
    expect(bank.children.map(itemName)).toEqual(['AAA-sub', 'Middle', 'Zebra']);
  });

  it('sets fullPath correctly for nested groups with multiple children at each level', () => {
    const tree = buildAccountTree([
      makeAccount(1, 'A/B/Leaf1'),
      makeAccount(2, 'A/B/Leaf2'),
      makeAccount(3, 'A/Other'),
    ]);
    const a = tree[0] as AccountGroupItem;
    expect(a.fullPath).toBe('A');
    const b = a.children.find(i => i.kind === 'group') as AccountGroupItem;
    expect(b.fullPath).toBe('A/B');
  });

  describe('single-child group collapsing', () => {
    it('inlines a leaf account when its group has only 1 child, using the full name at the root', () => {
      const tree = buildAccountTree([makeAccount(1, 'Bank/Checking')]);
      expect(tree).toHaveLength(1);
      expect(tree[0]).toMatchObject({ kind: 'account', account: { id: 1, displayName: 'Bank/Checking' } });
    });

    it('merges group names when a single-child group contains only a single-child subgroup, using the full name at the root', () => {
      const tree = buildAccountTree([
        makeAccount(1, 'Bank/Savings/Sub/Leaf'),
      ]);
      // Bank > Savings > Sub each have exactly 1 child, all collapse into one account row
      expect(tree).toHaveLength(1);
      expect(tree[0]).toMatchObject({ kind: 'account', account: { id: 1, displayName: 'Bank/Savings/Sub/Leaf' } });
    });

    it('inlines a leaf account relative to the surviving ancestor group, not the full name', () => {
      const tree = buildAccountTree([
        makeAccount(1, 'Bank/Sub/Leaf'),
        makeAccount(2, 'Bank/Other'),
      ]);
      // Bank has 2 children (Sub, Other) so it survives; Sub has 1 child so it collapses.
      expect(tree).toHaveLength(1);
      const bank = tree[0] as AccountGroupItem;
      expect(bank.kind).toBe('group');
      expect(bank.displayName).toBe('Bank');
      expect(bank.children).toHaveLength(2);
      const leaf = bank.children.find(i => i.kind === 'account' && i.account.id === 1);
      expect(leaf).toMatchObject({ kind: 'account', account: { id: 1, displayName: 'Sub/Leaf' } });
    });

    it('merges group names when a single-child group wraps a multi-child subgroup', () => {
      const tree = buildAccountTree([
        makeAccount(1, 'Bank/Savings/A'),
        makeAccount(2, 'Bank/Savings/B'),
      ]);
      // Bank has 1 child (Savings group), Savings has 2 children -> merge Bank+Savings name
      expect(tree).toHaveLength(1);
      const merged = tree[0] as AccountGroupItem;
      expect(merged.kind).toBe('group');
      expect(merged.displayName).toBe('Bank/Savings');
      expect(merged.fullPath).toBe('Bank/Savings');
      expect(merged.children).toHaveLength(2);
    });

    it('does not collapse a group with 2+ children', () => {
      const tree = buildAccountTree([
        makeAccount(1, 'Bank/Checking'),
        makeAccount(2, 'Bank/Savings'),
      ]);
      expect(tree).toHaveLength(1);
      expect(tree[0].kind).toBe('group');
      expect((tree[0] as AccountGroupItem).children).toHaveLength(2);
    });

    it('leaves flat (ungrouped) accounts untouched by collapsing', () => {
      const tree = buildAccountTree([makeAccount(1, 'Cash')]);
      expect(tree).toHaveLength(1);
      expect(tree[0]).toMatchObject({ kind: 'account', account: { id: 1, displayName: 'Cash' } });
    });
  });
});

describe('collectAccountIds', () => {
  it('returns ids of direct accounts in a flat group', () => {
    const group: AccountGroupItem = {
      kind: 'group',
      displayName: 'G',
      fullPath: 'G',
      children: [
        { kind: 'account', account: { id: 1, user_id: 1, name: 'a', currency: 'USD', scale: 2, balance: 0, user_balance: 0, start_balance: 0, deleted: false, created_at: '', type: 'cash', settings: {}, displayName: 'a' } },
        { kind: 'account', account: { id: 2, user_id: 1, name: 'b', currency: 'USD', scale: 2, balance: 0, user_balance: 0, start_balance: 0, deleted: false, created_at: '', type: 'cash', settings: {}, displayName: 'b' } },
      ],
    };
    expect(collectAccountIds(group)).toEqual([1, 2]);
  });

  it('collects ids recursively from nested groups', () => {
    const inner: AccountGroupItem = {
      kind: 'group',
      displayName: 'Sub',
      fullPath: 'Group/Sub',
      children: [
        { kind: 'account', account: { id: 3, user_id: 1, name: 'c', currency: 'USD', scale: 2, balance: 0, user_balance: 0, start_balance: 0, deleted: false, created_at: '', type: 'cash', settings: {}, displayName: 'c' } },
      ],
    };
    const group: AccountGroupItem = {
      kind: 'group',
      displayName: 'Group',
      fullPath: 'Group',
      children: [
        { kind: 'account', account: { id: 1, user_id: 1, name: 'a', currency: 'USD', scale: 2, balance: 0, user_balance: 0, start_balance: 0, deleted: false, created_at: '', type: 'cash', settings: {}, displayName: 'a' } },
        inner,
        { kind: 'account', account: { id: 2, user_id: 1, name: 'b', currency: 'USD', scale: 2, balance: 0, user_balance: 0, start_balance: 0, deleted: false, created_at: '', type: 'cash', settings: {}, displayName: 'b' } },
      ],
    };
    expect(collectAccountIds(group).sort()).toEqual([1, 2, 3]);
  });
});

describe('collectUserBalance', () => {
  function accountItem(id: number, userBalance: number | null) {
    return {
      kind: 'account' as const,
      account: { ...makeAccount(id, `a${id}`), user_balance: userBalance, displayName: `a${id}` },
    };
  }

  it('sums user_balance across direct accounts in a flat group', () => {
    const group: AccountGroupItem = { kind: 'group', displayName: 'G', fullPath: 'G', children: [accountItem(1, 100), accountItem(2, 250)] };
    expect(collectUserBalance(group)).toBe(350);
  });

  it('sums recursively across nested groups', () => {
    const inner: AccountGroupItem = { kind: 'group', displayName: 'Sub', fullPath: 'Group/Sub', children: [accountItem(3, 50)] };
    const group: AccountGroupItem = {
      kind: 'group',
      displayName: 'Group',
      fullPath: 'Group',
      children: [accountItem(1, 100), inner, accountItem(2, 200)],
    };
    expect(collectUserBalance(group)).toBe(350);
  });

  it('returns null if any account in the subtree has no user_balance', () => {
    const group: AccountGroupItem = { kind: 'group', displayName: 'G', fullPath: 'G', children: [accountItem(1, 100), accountItem(2, null)] };
    expect(collectUserBalance(group)).toBeNull();
  });
});
