import { describe, it, expect, beforeEach } from 'vitest';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { Categories } from './categories';
import { CategoriesState } from '../../core/categories.state';
import { CategoryDialogService } from './category-dialog.service';
import { AuthService } from '../../core/auth.service';
import type { Category } from '../../models/category';

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

const mine = makeCategory({ id: 10, name: 'Mine' });
const foreign = makeCategory({ id: 20, name: 'Theirs', user_id: OTHER, owner_name: 'Other User' });
const withChild = makeCategory({
  id: 30,
  name: 'HasChild',
  children: [makeCategory({ id: 31, name: 'HasChild / Leaf' })],
});

const tree: Category[] = [
  makeCategory({
    id: 2,
    name: 'Expenses',
    user_id: null,
    parent_id: null,
    fullName: '',
    children: [mine, foreign, withChild],
  }),
];

function configure() {
  TestBed.configureTestingModule({
    providers: [
      Categories,
      { provide: CategoriesState, useValue: { categories: signal(tree), loading: signal(false) } },
      { provide: CategoryDialogService, useValue: {} },
      { provide: AuthService, useValue: { user: signal({ id: ME }) } },
    ],
  });
  return TestBed.inject(Categories);
}

describe('Categories management screen', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('shows foreign categories in the tree', () => {
    const screen = configure();
    const expenses = screen.categories()[0];

    expect(expenses.children?.map(c => c.id)).toContain(foreign.id);
  });

  it("does not allow editing or deleting another user's category", () => {
    const screen = configure();
    screen.setAsSelected(foreign);

    expect(screen.isEditable()).toBe(false);
    expect(screen.isDeletable()).toBe(false);
  });

  it('allows editing and deleting my own leaf category', () => {
    const screen = configure();
    screen.setAsSelected(mine);

    expect(screen.isEditable()).toBe(true);
    expect(screen.isDeletable()).toBe(true);
  });

  it('still refuses to delete my own category that has children', () => {
    const screen = configure();
    screen.setAsSelected(withChild);

    expect(screen.isEditable()).toBe(true);
    expect(screen.isDeletable()).toBe(false);
  });

  it('refuses to edit or delete a system root', () => {
    const screen = configure();
    screen.setAsSelected(tree[0]);

    expect(screen.isEditable()).toBe(false);
    expect(screen.isDeletable()).toBe(false);
  });
});
