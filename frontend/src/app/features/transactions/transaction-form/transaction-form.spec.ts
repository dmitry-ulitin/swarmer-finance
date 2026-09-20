import { describe, it, expect, beforeEach } from 'vitest';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { POLYMORPHEUS_CONTEXT } from '@taiga-ui/polymorpheus';
import { TransactionForm } from './transaction-form';
import { CategoriesState } from '../../../core/categories.state';
import { AccountsState } from '../../../core/accounts.state';
import { TransactionsState } from '../../../core/transactions.state';
import { AuthService } from '../../../core/auth.service';
import { NotificationService } from '../../../core/notification.service';
import type { Category } from '../../../models/category';
import type { Transaction } from '../../../models/transaction';

const ME = 1;
const OTHER = 2;

function makeCategory(overrides: Partial<Category> & Pick<Category, 'id' | 'name'>): Category {
  return {
    user_id: ME,
    parent_id: 2,
    color: '#111111',
    icon: 'tag',
    created_at: '',
    owner_name: null,
    fullName: overrides.name,
    root_id: 2,
    ...overrides,
  };
}

// My own expense category, and one owned by someone I share an account with.
const myCategory = makeCategory({ id: 10, name: 'Groceries' });
const foreignCategory = makeCategory({
  id: 20,
  name: 'Their Groceries',
  user_id: OTHER,
  owner_name: 'Other User',
});

const tree: Category[] = [
  makeCategory({ id: 1, name: 'Income', user_id: null, parent_id: null, root_id: 1, children: [] }),
  makeCategory({
    id: 2,
    name: 'Expenses',
    user_id: null,
    parent_id: null,
    children: [myCategory, foreignCategory],
  }),
];

function configure(data: Partial<Transaction>) {
  TestBed.configureTestingModule({
    providers: [
      TransactionForm,
      { provide: POLYMORPHEUS_CONTEXT, useValue: { data, completeWith: () => {} } },
      { provide: CategoriesState, useValue: { categories: signal(tree) } },
      { provide: AccountsState, useValue: { accounts: signal([]) } },
      { provide: TransactionsState, useValue: { transactions: signal([]) } },
      { provide: AuthService, useValue: { user: signal({ id: ME }) } },
      { provide: NotificationService, useValue: { showError: () => {} } },
    ],
  });
  return TestBed.inject(TransactionForm);
}

describe('TransactionForm category initialisation', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it("keeps another user's category instead of falling back to the first one", () => {
    // A transaction on a shared account, entered by someone else: its
    // category is not in this user's own branch of the tree.
    const form = configure({
      debit_account: { id: 1, name: 'Shared', currency: 'USD', scale: 2 },
      category: foreignCategory,
    });

    expect(form.form.controls.category.value?.id).toBe(foreignCategory.id);
    expect(form.form.controls.category.value?.name).toBe('Their Groceries');
  });

  it('keeps a category the loaded tree does not contain at all', () => {
    // The tree can lag behind — it is loaded once per session, so a
    // category created after that load is missing from it. Resolving the
    // control's value by looking the id up in the tree silently dropped
    // such a category and reset the field to the first visible one.
    const missing = makeCategory({
      id: 99,
      name: 'Not In Tree',
      user_id: OTHER,
      owner_name: 'Other User',
    });

    const form = configure({
      debit_account: { id: 1, name: 'Shared', currency: 'USD', scale: 2 },
      category: missing,
    });

    expect(form.form.controls.category.value?.id).toBe(99);
    expect(form.form.controls.category.value?.name).toBe('Not In Tree');
  });

  it("uses the transaction's own category when it belongs to this user", () => {
    const form = configure({
      debit_account: { id: 1, name: 'Mine', currency: 'USD', scale: 2 },
      category: myCategory,
    });

    expect(form.form.controls.category.value?.id).toBe(myCategory.id);
  });

  it('falls back to the first visible category for a new transaction', () => {
    const form = configure({
      debit_account: { id: 1, name: 'Mine', currency: 'USD', scale: 2 },
    });

    expect(form.form.controls.category.value?.id).toBe(myCategory.id);
  });

  it('flags a foreign category and leaves the user’s own unflagged', () => {
    const form = configure({ debit_account: { id: 1, name: 'Mine', currency: 'USD', scale: 2 } });

    expect(form.isForeign(foreignCategory)).toBe(true);
    expect(form.isForeign(myCategory)).toBe(false);
    // System categories belong to everyone.
    expect(form.isForeign(tree[1])).toBe(false);
  });
});
