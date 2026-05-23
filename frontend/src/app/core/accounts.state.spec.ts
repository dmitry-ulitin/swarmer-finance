import { describe, it, expect } from 'vitest';
import { buildAccountTree, collectAccountIds, AccountNode } from './accounts.state';
import { Account } from '../models/account';

function makeAccount(id: number, name: string): Account {
  return { id, user_id: 1, name, currency: 'USD', start_balance: 0, created_at: '' };
}

describe('buildAccountTree', () => {
  it('returns empty array for no accounts', () => {
    expect(buildAccountTree([])).toEqual([]);
  });

  it('puts flat accounts into an ungrouped root node with empty name', () => {
    const tree = buildAccountTree([makeAccount(1, 'Cash'), makeAccount(2, 'Wallet')]);
    expect(tree).toHaveLength(1);
    const [root] = tree;
    expect(root.name).toBe('');
    expect(root.fullPath).toBe('');
    expect(root.children).toHaveLength(2);
    expect(root.children[0]).toMatchObject({ kind: 'account', account: { id: 1, displayName: 'Cash' } });
    expect(root.children[1]).toMatchObject({ kind: 'account', account: { id: 2, displayName: 'Wallet' } });
  });

  it('sorts flat accounts alphabetically (case-insensitive)', () => {
    const tree = buildAccountTree([
      makeAccount(1, 'Zebra'),
      makeAccount(2, 'apple'),
      makeAccount(3, 'Mango'),
    ]);
    const names = tree[0].children.map(i => i.kind === 'account' ? i.account.displayName : '');
    expect(names).toEqual(['apple', 'Mango', 'Zebra']);
  });

  it('creates a group node for accounts with "/" in name', () => {
    const tree = buildAccountTree([makeAccount(1, 'Bank/Checking')]);
    expect(tree).toHaveLength(1);
    const [group] = tree;
    expect(group.name).toBe('Bank');
    expect(group.fullPath).toBe('Bank');
    expect(group.children).toHaveLength(1);
    expect(group.children[0]).toMatchObject({ kind: 'account', account: { id: 1, displayName: 'Checking' } });
  });

  it('shares a single group node for multiple accounts with the same prefix', () => {
    const tree = buildAccountTree([
      makeAccount(1, 'Bank/Checking'),
      makeAccount(2, 'Bank/Savings'),
    ]);
    expect(tree).toHaveLength(1);
    expect(tree[0].name).toBe('Bank');
    expect(tree[0].children).toHaveLength(2);
  });

  it('interleaves accounts and sub-groups alphabetically within a group', () => {
    const tree = buildAccountTree([
      makeAccount(1, 'Bank/Zebra'),
      makeAccount(2, 'Bank/AAA-sub/Deep'),
      makeAccount(3, 'Bank/Middle'),
    ]);
    const bank = tree[0];
    const names = bank.children.map(i =>
      i.kind === 'account' ? i.account.displayName : i.node.name
    );
    expect(names).toEqual(['AAA-sub', 'Middle', 'Zebra']);
  });

  it('handles deep nesting (3 levels): A/B/Leaf creates A > B(group) > Leaf(account)', () => {
    const tree = buildAccountTree([makeAccount(1, 'A/B/Leaf')]);
    expect(tree).toHaveLength(1);
    const a = tree[0];
    expect(a.name).toBe('A');
    expect(a.children[0].kind).toBe('group');
    if (a.children[0].kind === 'group') {
      const b = a.children[0].node;
      expect(b.name).toBe('B');
      expect(b.children[0].kind).toBe('account');
      if (b.children[0].kind === 'account') {
        expect(b.children[0].account.displayName).toBe('Leaf');
        expect(b.children[0].account.id).toBe(1);
      }
    }
  });

  it('mixes flat and grouped accounts at the root level, sorted alphabetically', () => {
    const tree = buildAccountTree([
      makeAccount(1, 'Zebra'),
      makeAccount(2, 'Alpha/Sub'),
      makeAccount(3, 'Middle'),
    ]);
    // Should produce: ungrouped root (Zebra, Middle) and Alpha group
    // Roots sorted: '' (ungrouped) and 'Alpha' — order depends on insertion
    const groupNode = tree.find(n => n.name === 'Alpha');
    const ungroupedNode = tree.find(n => n.name === '');
    expect(groupNode).toBeDefined();
    expect(ungroupedNode).toBeDefined();
    // ungrouped accounts sorted
    const ungroupedNames = ungroupedNode!.children.map(i =>
      i.kind === 'account' ? i.account.displayName : ''
    );
    expect(ungroupedNames).toEqual(['Middle', 'Zebra']);
  });

  it('sorts root nodes alphabetically', () => {
    const tree = buildAccountTree([
      makeAccount(1, 'Zebra/A'),
      makeAccount(2, 'Alpha/B'),
      makeAccount(3, 'Middle/C'),
    ]);
    expect(tree.map(n => n.name)).toEqual(['Alpha', 'Middle', 'Zebra']);
  });

  it('sets fullPath correctly for nested groups', () => {
    const tree = buildAccountTree([makeAccount(1, 'A/B/Leaf')]);
    const a = tree[0];
    expect(a.fullPath).toBe('A');
    if (a.children[0].kind === 'group') {
      expect(a.children[0].node.fullPath).toBe('A/B');
    }
  });
});

describe('collectAccountIds', () => {
  it('returns ids of direct accounts in a flat node', () => {
    const node: AccountNode = {
      name: '',
      fullPath: '',
      children: [
        { kind: 'account', account: { id: 1, user_id: 1, name: 'a', currency: 'USD', start_balance: 0, created_at: '', displayName: 'a' } },
        { kind: 'account', account: { id: 2, user_id: 1, name: 'b', currency: 'USD', start_balance: 0, created_at: '', displayName: 'b' } },
      ],
    };
    expect(collectAccountIds(node)).toEqual([1, 2]);
  });

  it('collects ids recursively from nested groups', () => {
    const inner: AccountNode = {
      name: 'Sub',
      fullPath: 'Group/Sub',
      children: [
        { kind: 'account', account: { id: 3, user_id: 1, name: 'c', currency: 'USD', start_balance: 0, created_at: '', displayName: 'c' } },
      ],
    };
    const node: AccountNode = {
      name: 'Group',
      fullPath: 'Group',
      children: [
        { kind: 'account', account: { id: 1, user_id: 1, name: 'a', currency: 'USD', start_balance: 0, created_at: '', displayName: 'a' } },
        { kind: 'group', node: inner },
        { kind: 'account', account: { id: 2, user_id: 1, name: 'b', currency: 'USD', start_balance: 0, created_at: '', displayName: 'b' } },
      ],
    };
    expect(collectAccountIds(node).sort()).toEqual([1, 2, 3]);
  });
});
