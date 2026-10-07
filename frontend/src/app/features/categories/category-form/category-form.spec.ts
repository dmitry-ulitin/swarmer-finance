import { describe, it, expect, beforeEach, vi } from 'vitest';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { POLYMORPHEUS_CONTEXT } from '@taiga-ui/polymorpheus';
import { of } from 'rxjs';
import { CategoryForm, type CategoryFormData } from './category-form';
import { CategoriesState } from '../../../core/categories.state';
import { NotificationService } from '../../../core/notification.service';
import type { Category } from '../../../models/category';

function makeCategory(overrides: Partial<Category> & Pick<Category, 'id' | 'name'>): Category {
  return {
    user_id: 1,
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

const salary = makeCategory({ id: 11, name: 'Salary', parent_id: 1, root_id: 1, color: '#00aa00', icon: 'wallet' });
const snacks = makeCategory({ id: 13, name: 'Snacks', parent_id: 12, fullName: 'Food / Snacks' });
const food = makeCategory({ id: 12, name: 'Food', color: '#aa0000', icon: 'utensils', children: [snacks] });
const income = makeCategory({ id: 1, name: 'Income', user_id: null, parent_id: null, root_id: 1, children: [salary] });
const expenses = makeCategory({ id: 2, name: 'Expenses', user_id: null, parent_id: null, children: [food] });

function configure(data: CategoryFormData) {
  const create = vi.fn(() => of({ data: { id: 99 }, error: null }));
  const update = vi.fn(() => of({ data: { id: 13 }, error: null }));
  const completeWith = vi.fn();
  TestBed.configureTestingModule({
    providers: [
      CategoryForm,
      { provide: POLYMORPHEUS_CONTEXT, useValue: { data, completeWith } },
      { provide: CategoriesState, useValue: { categories: signal([income, expenses]), create, update } },
      { provide: NotificationService, useValue: { showError: () => {} } },
    ],
  });
  return { form: TestBed.inject(CategoryForm), create, update, completeWith };
}

describe('CategoryForm', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('offers both roots when the root is free, starting under Expenses', () => {
    const { form } = configure({ parent: null });
    expect(form.parentOptions().map(c => c.id)).toEqual([1, 2]);
    expect(form.form.controls.parent.value?.id).toBe(2);
  });

  it('keeps a new category to the given root, starting at the root itself', () => {
    const { form } = configure({ parent: null, rootId: 1 });
    expect(form.parentOptions().map(c => c.id)).toEqual([1]);
    expect(form.form.controls.parent.value?.id).toBe(1);
    expect(form.icons()[0]).toBe('circle-plus');
  });

  it("starts a new category under the given parent, with its look, and expands the path to it", () => {
    const { form } = configure({ parent: snacks });
    expect(form.form.controls.parent.value).toBe(snacks);
    expect(form.form.getRawValue()).toMatchObject({ color: snacks.color, icon: snacks.icon });
    expect([...form.treeMap.keys()]).toEqual([expenses, food]);
  });

  it("takes the new parent's look when the parent changes", () => {
    const { form } = configure({ parent: null });
    form.form.controls.parent.setValue(food);
    expect(form.form.getRawValue()).toMatchObject({ color: food.color, icon: food.icon });
  });

  it('creates under the picked parent', async () => {
    const { form, create, completeWith } = configure({ parent: food, rootId: 2 });
    form.form.controls.name.setValue('Coffee');
    await form.onSubmit();
    expect(create).toHaveBeenCalledWith({ name: 'Coffee', parentId: 12, color: food.color, icon: food.icon });
    expect(completeWith).toHaveBeenCalledWith({ id: 99 });
  });

  it('edits in place: the parent is fixed and not offered the category itself', async () => {
    const { form, update, create } = configure({ category: snacks });
    expect(form.isEdit).toBe(true);
    expect(form.form.controls.parent.disabled).toBe(true);
    expect(form.form.controls.parent.value).toBe(food);
    expect(form.treeHandler(food)).toEqual([]);

    form.form.controls.name.setValue('Treats');
    await form.onSubmit();
    expect(update).toHaveBeenCalledWith(13, { name: 'Treats', color: snacks.color, icon: snacks.icon });
    expect(create).not.toHaveBeenCalled();
  });
});
