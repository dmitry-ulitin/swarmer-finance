import { describe, it, expect, beforeEach } from 'vitest';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { CategorySelect } from './category-select';
import { CategoriesState } from '../../../core/categories.state';
import { AuthService } from '../../../core/auth.service';
import type { Category } from '../../../models/category';

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

const myExpense = makeCategory({ id: 10, name: 'Groceries' });
const foreignExpense = makeCategory({
  id: 20,
  name: 'Their Groceries',
  user_id: OTHER,
  owner_name: 'Other User',
});
const myIncome = makeCategory({ id: 30, name: 'Salary', parent_id: 1, root_id: 1 });

const tree: Category[] = [
  makeCategory({
    id: 1, name: 'Income', user_id: null, parent_id: null, root_id: 1,
    children: [myIncome],
  }),
  makeCategory({
    id: 2, name: 'Expenses', user_id: null, parent_id: null,
    children: [myExpense, foreignExpense],
  }),
];

function create(rootId: number) {
  TestBed.configureTestingModule({
    providers: [
      { provide: CategoriesState, useValue: { categories: signal(tree) } },
      { provide: AuthService, useValue: { user: signal({ id: ME }) } },
    ],
  });
  const fixture = TestBed.createComponent(CategorySelect);
  fixture.componentRef.setInput('rootId', rootId);
  fixture.detectChanges();
  return fixture.componentInstance;
}

describe('CategorySelect', () => {
  beforeEach(() => TestBed.resetTestingModule());

  describe('visibleCategories', () => {
    it('lists the children of the requested root', () => {
      expect(create(2).visibleCategories().map(c => c.name)).toEqual([
        'Groceries',
        'Their Groceries',
      ]);
    });

    it('lists the income branch for root 1', () => {
      expect(create(1).visibleCategories().map(c => c.name)).toEqual(['Salary']);
    });
  });

  describe('isForeign', () => {
    it('is false for a category I own', () => {
      expect(create(2).isForeign(myExpense)).toBe(false);
    });

    it('is true for a category someone else owns', () => {
      expect(create(2).isForeign(foreignExpense)).toBe(true);
    });

    it('is false for a system category, which has no owner', () => {
      const system = makeCategory({ id: 3, name: 'System', user_id: null });
      expect(create(2).isForeign(system)).toBe(false);
    });
  });

  describe('categoryMatcher', () => {
    it('matches on path and root rather than id', () => {
      // The tree holds one node per path, so a transaction may reference a
      // row that lost the dedupe to an equivalent one. Matching by id would
      // leave such a category unhighlighted in the dropdown.
      const twin = makeCategory({ id: 999, name: 'Groceries' });
      expect(create(2).categoryMatcher(myExpense, twin)).toBe(true);
    });

    it('does not match different paths', () => {
      expect(create(2).categoryMatcher(myExpense, foreignExpense)).toBe(false);
    });

    it('does not match the same path under different roots', () => {
      const sameNameIncome = makeCategory({ id: 40, name: 'Groceries', root_id: 1 });
      expect(create(2).categoryMatcher(myExpense, sameNameIncome)).toBe(false);
    });
  });

  describe('stringify', () => {
    it('prefers the full path', () => {
      const nested = makeCategory({ id: 11, name: 'Fruit', fullName: 'Groceries / Fruit' });
      expect(create(2).stringify(nested)).toBe('Groceries / Fruit');
    });

    it('renders null as Uncategorized', () => {
      expect(create(2).stringify(null)).toBe('Uncategorized');
    });
  });
});
