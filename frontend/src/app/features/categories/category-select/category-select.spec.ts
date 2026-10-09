import { describe, it, expect, beforeEach, onTestFinished, vi } from 'vitest';
import { ChangeDetectionStrategy, ChangeDetectorRef, Component, signal } from '@angular/core';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { TestBed } from '@angular/core/testing';
import { provideTaiga, TuiRoot, TuiTextfieldComponent } from '@taiga-ui/core';
import { CategorySelect } from './category-select';
import { CategoriesState } from '../../../core/categories.state';
import { AuthService } from '../../../core/auth.service';
import { CategoryDialogService } from '../category-dialog.service';
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

function setup(
  rootId: number,
  openCreate: (parent: Category | null, rootId?: number) => Promise<Category | null> = async () => null,
) {
  TestBed.configureTestingModule({
    providers: [
      { provide: CategoriesState, useValue: { categories: signal(tree) } },
      { provide: AuthService, useValue: { user: signal({ id: ME }) } },
      { provide: CategoryDialogService, useValue: { openCreate } },
    ],
  });
  const fixture = TestBed.createComponent(CategorySelect);
  fixture.componentRef.setInput('rootId', rootId);
  fixture.detectChanges();
  return fixture;
}

function create(rootId: number) {
  return setup(rootId).componentInstance;
}

// The dropdown is a portal, which needs tui-root to render into.
@Component({
  imports: [TuiRoot, CategorySelect],
  template: `<tui-root><app-category-select [rootId]="2" /></tui-root>`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
class RootHost {}

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

  describe('addCategory', () => {
    it.each([2, 1])("creates it in root %i's branch and selects it", async rootId => {
      const created = makeCategory({ id: 50, name: 'New', root_id: rootId });
      const openCreate = vi.fn(async () => created);
      const select = setup(rootId, openCreate).componentInstance;
      const onChange = vi.fn();
      select.registerOnChange(onChange);

      await select.addCategory();

      expect(openCreate).toHaveBeenCalledWith(null, rootId);
      expect(onChange).toHaveBeenCalledWith(created);
    });

    it('keeps the category when the dialog is cancelled', async () => {
      const select = create(2);
      select.writeValue(myExpense);
      const onChange = vi.fn();
      select.registerOnChange(onChange);

      await select.addCategory();

      expect(onChange).not.toHaveBeenCalled();
    });

    it('offers it below the tree in the open dropdown', async () => {
      // jsdom has no matchMedia, which tui-root reads.
      vi.stubGlobal('matchMedia', () => ({
        matches: false, addEventListener() {}, removeEventListener() {},
      }));
      onTestFinished(() => { vi.unstubAllGlobals(); });
      TestBed.configureTestingModule({
        providers: [
          provideTaiga(),
          { provide: CategoriesState, useValue: { categories: signal(tree) } },
          { provide: AuthService, useValue: { user: signal({ id: ME }) } },
        ],
      });
      const fixture = TestBed.createComponent(RootHost);
      await fixture.whenStable();
      (fixture.nativeElement as HTMLElement).querySelector('input')!.click();
      await fixture.whenStable();
      const options = [...document.querySelectorAll('tui-data-list button')];
      expect(options).toHaveLength(3);
      expect(options.at(-1)!.textContent?.trim()).toBe('Add category…');
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

@Component({
  imports: [ReactiveFormsModule, CategorySelect],
  template: `<app-category-select [rootId]="2" [formControl]="control" />`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
class Host {
  readonly control = new FormControl<Category | null>(myExpense);
}

describe('CategorySelect in a form', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('shows a value set from outside without being touched', async () => {
    TestBed.configureTestingModule({
      providers: [
        { provide: CategoriesState, useValue: { categories: signal(tree) } },
        { provide: AuthService, useValue: { user: signal({ id: ME }) } },
      ],
    });
    const fixture = TestBed.createComponent(Host);
    await fixture.whenStable();
    const input = (fixture.nativeElement as HTMLElement).querySelector('input')!;
    expect(input.value).toBe('Groceries');

    fixture.componentInstance.control.setValue(foreignExpense);
    await fixture.whenStable();
    expect(input.value).toBe('Their Groceries');
  });

  it('shows the selected category with its coloured icon and full path', async () => {
    TestBed.configureTestingModule({
      providers: [
        { provide: CategoriesState, useValue: { categories: signal(tree) } },
        { provide: AuthService, useValue: { user: signal({ id: ME }) } },
      ],
    });
    const fixture = TestBed.createComponent(Host);
    fixture.componentInstance.control.setValue(
      makeCategory({ id: 11, name: 'Fruit', fullName: 'Groceries / Fruit', color: '#ff0000' }),
    );
    await fixture.whenStable();
    // Under TestBed the textfield's OnPush view is not re-checked after
    // ngModel's deferred write, so its [content] slot stays empty; the app
    // renders it without help. Refresh it by hand to check our template.
    fixture.debugElement
      .query(e => e.componentInstance instanceof TuiTextfieldComponent)
      .injector.get(ChangeDetectorRef)
      .detectChanges();
    const selected = (fixture.nativeElement as HTMLElement).querySelector('.selected-option')!;
    expect(selected.textContent?.trim()).toBe('Groceries / Fruit');
    expect(selected.querySelector('tui-icon')!.getAttribute('style')).toContain('color: rgb(255, 0, 0)');
  });
});
