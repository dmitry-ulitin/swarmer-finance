import { describe, it, expect, beforeEach, vi } from 'vitest';
import { signal, type WritableSignal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { POLYMORPHEUS_CONTEXT } from '@taiga-ui/polymorpheus';
import { of, throwError } from 'rxjs';
import { HttpErrorResponse } from '@angular/common/http';
import { ImportReview } from './import-review';
import { ApiService } from '../../../core/api.service';
import { CategoriesState } from '../../../core/categories.state';
import { AccountsState } from '../../../core/accounts.state';
import { AuthService } from '../../../core/auth.service';
import { NotificationService } from '../../../core/notification.service';
import type { Category } from '../../../models/category';
import type { Account } from '../../../models/account';
import type { ImportParseResult, ImportRow, ImportRowStatus } from '../../../models/import';

const ME = 1;

function makeCategory(overrides: Partial<Category> & Pick<Category, 'id' | 'name'>): Category {
  return {
    user_id: ME, parent_id: 2, color: '#111', icon: 'tag', created_at: '',
    owner_name: null, fullName: overrides.name, root_id: 2, ...overrides,
  };
}

const groceries = makeCategory({ id: 10, name: 'Groceries' });
const tree: Category[] = [
  makeCategory({ id: 1, name: 'Income', user_id: null, parent_id: null, root_id: 1, children: [] }),
  makeCategory({ id: 2, name: 'Expenses', user_id: null, parent_id: null, children: [groceries] }),
];

function makeAccount(id: number, name: string, currency = 'EUR'): Account {
  return {
    id, user_id: ME, name, currency, scale: 2, start_balance: 0, balance: 0,
    user_balance: 0, deleted: false, created_at: '', type: 'bank', settings: {},
  };
}

// Account 7 is the one being imported into (see makeResult).
const imported = makeAccount(7, 'LHV');
const wiseUsd = makeAccount(8, 'Wise USD', 'USD');
const cash = makeAccount(9, 'Cash');

function makeRow(i: number, status: ImportRowStatus, amount = -10): ImportRow {
  return {
    index: i,
    date: '2026-07-01',
    amount,
    description: `Row ${i}`,
    payee: `Merchant ${i}`,
    hash: `hash-${i}`,
    status,
    duplicateOf: status === 'new' ? null : 500 + i,
    suggestedCategoryId: null,
    suggestionSource: null,
  };
}

function makeResult(rows: ImportRow[]): ImportParseResult {
  return {
    format: 'lhv',
    account: { id: 7, name: 'LHV', currency: 'EUR', scale: 2 },
    rows,
    summary: {
      total: rows.length,
      new: rows.filter(r => r.status === 'new').length,
      duplicate: rows.filter(r => r.status === 'duplicate').length,
      possibleDuplicate: rows.filter(r => r.status === 'possible_duplicate').length,
    },
  };
}

function configure(
  result: ImportParseResult,
  api: Partial<ApiService> = {},
  categories: WritableSignal<Category[]> = signal(tree),
  transferTargets: WritableSignal<Account[]> = signal([imported, wiseUsd, cash])
) {
  const completeWith = vi.fn();
  const showError = vi.fn();
  TestBed.configureTestingModule({
    providers: [
      ImportReview,
      { provide: POLYMORPHEUS_CONTEXT, useValue: { data: result, completeWith } },
      { provide: ApiService, useValue: api },
      { provide: CategoriesState, useValue: { categories } },
      { provide: AccountsState, useValue: { transferTargets } },
      { provide: AuthService, useValue: { user: signal({ id: ME }) } },
      { provide: NotificationService, useValue: { showError, showSuccess: vi.fn() } },
    ],
  });
  return { component: TestBed.inject(ImportReview), completeWith, showError };
}

describe('ImportReview', () => {
  beforeEach(() => TestBed.resetTestingModule());

  describe('initial selection', () => {
    it('selects new rows', () => {
      const { component } = configure(makeResult([makeRow(0, 'new')]));
      expect(component.rows()[0].selected).toBe(true);
    });

    it('deselects possible duplicates', () => {
      const { component } = configure(makeResult([makeRow(0, 'possible_duplicate')]));
      expect(component.rows()[0].selected).toBe(false);
    });

    it('deselects exact duplicates', () => {
      const { component } = configure(makeResult([makeRow(0, 'duplicate')]));
      expect(component.rows()[0].selected).toBe(false);
    });
  });

  describe('selection toggling', () => {
    it('toggles one row without touching the others', () => {
      const { component } = configure(makeResult([makeRow(0, 'new'), makeRow(1, 'new')]));

      component.toggle(0, false);

      expect(component.rows()[0].selected).toBe(false);
      expect(component.rows()[1].selected).toBe(true);
    });

    it('selects every row at once', () => {
      const { component } = configure(makeResult([makeRow(0, 'new'), makeRow(1, 'duplicate')]));

      component.toggleAll(true);

      expect(component.rows().every(r => r.selected)).toBe(true);
    });

    it('deselects every row at once', () => {
      const { component } = configure(makeResult([makeRow(0, 'new'), makeRow(1, 'new')]));

      component.toggleAll(false);

      expect(component.rows().some(r => r.selected)).toBe(false);
    });

    it('counts the selected rows', () => {
      const { component } = configure(
        makeResult([makeRow(0, 'new'), makeRow(1, 'new'), makeRow(2, 'duplicate')])
      );
      expect(component.selectedCount()).toBe(2);
    });
  });

  describe('category root', () => {
    it('offers expense categories for a negative amount', () => {
      const { component } = configure(makeResult([makeRow(0, 'new', -25)]));
      expect(component.rootIdFor(component.rows()[0])).toBe(2);
    });

    it('offers income categories for a positive amount', () => {
      const { component } = configure(makeResult([makeRow(0, 'new', 25)]));
      expect(component.rootIdFor(component.rows()[0])).toBe(1);
    });
  });

  describe('submit', () => {
    it('sends only the selected rows', async () => {
      const reconcileImport = vi.fn().mockReturnValue(of({ data: { created: 1, skipped: 0 }, error: null }));
      const { component } = configure(
        makeResult([makeRow(0, 'new'), makeRow(1, 'duplicate')]),
        { reconcileImport } as never
      );

      await component.submit();

      const [accountId, rows] = reconcileImport.mock.calls[0];
      expect(accountId).toBe(7);
      expect(rows).toHaveLength(1);
      expect(rows[0].hash).toBe('hash-0');
    });

    it('carries the chosen category id on the row', async () => {
      const reconcileImport = vi.fn().mockReturnValue(of({ data: { created: 1, skipped: 0 }, error: null }));
      const { component } = configure(makeResult([makeRow(0, 'new')]), { reconcileImport } as never);

      component.setCategory(0, groceries);
      await component.submit();

      expect(reconcileImport.mock.calls[0][1][0].categoryId).toBe(10);
    });

    it('sends null when no category was chosen, so the server applies its default', async () => {
      const reconcileImport = vi.fn().mockReturnValue(of({ data: { created: 1, skipped: 0 }, error: null }));
      const { component } = configure(makeResult([makeRow(0, 'new')]), { reconcileImport } as never);

      await component.submit();

      expect(reconcileImport.mock.calls[0][1][0].categoryId).toBeNull();
    });

    it('sends the fields reconcile needs and nothing it rejects', async () => {
      const reconcileImport = vi.fn().mockReturnValue(of({ data: { created: 1, skipped: 0 }, error: null }));
      const { component } = configure(makeResult([makeRow(0, 'new')]), { reconcileImport } as never);

      await component.submit();

      expect(Object.keys(reconcileImport.mock.calls[0][1][0]).sort()).toEqual([
        'amount', 'categoryId', 'date', 'description', 'hash', 'payee', 'transferAccountId',
      ]);
    });

    it('closes with the reconcile result', async () => {
      const reconcileImport = vi.fn().mockReturnValue(of({ data: { created: 3, skipped: 1 }, error: null }));
      const { component, completeWith } = configure(
        makeResult([makeRow(0, 'new')]), { reconcileImport } as never
      );

      await component.submit();

      expect(completeWith).toHaveBeenCalledWith({ created: 3, skipped: 1 });
    });

    it('does nothing when no rows are selected', async () => {
      const reconcileImport = vi.fn();
      const { component, completeWith } = configure(
        makeResult([makeRow(0, 'duplicate')]), { reconcileImport } as never
      );

      await component.submit();

      expect(reconcileImport).not.toHaveBeenCalled();
      expect(completeWith).not.toHaveBeenCalled();
    });

    it('reports a failure and stays open', async () => {
      const reconcileImport = vi.fn().mockReturnValue(
        throwError(() => new HttpErrorResponse({
          status: 403,
          error: { data: null, error: 'Cannot use this category' },
        }))
      );
      const { component, completeWith, showError } = configure(
        makeResult([makeRow(0, 'new')]), { reconcileImport } as never
      );

      await component.submit();

      expect(showError).toHaveBeenCalled();
      expect(completeWith).not.toHaveBeenCalled();
    });
  });

  describe('category suggestions', () => {
    const suggested = (id: number | null, source: 'payee' | 'description' | 'mcc' = 'payee'): ImportRow => ({
      ...makeRow(0, 'new'),
      suggestedCategoryId: id,
      suggestionSource: id === null ? null : source,
    });

    it('pre-fills the suggested category and marks it', () => {
      const { component } = configure(makeResult([suggested(10)]));
      const row = component.rows()[0];
      expect(component.categoryOf(row)).toBe(groceries);
      expect(row.suggested).toBe(true);
    });

    it('leaves a row without a suggestion unmarked', () => {
      const { component } = configure(makeResult([suggested(null)]));
      const row = component.rows()[0];
      expect(component.categoryOf(row)).toBeNull();
      expect(row.suggested).toBe(false);
    });

    it('drops the mark once the user picks a category', () => {
      const { component } = configure(makeResult([suggested(10)]));
      component.setCategory(0, null);
      const row = component.rows()[0];
      expect(row.suggested).toBe(false);
      expect(component.categoryOf(row)).toBeNull();
    });

    it('leaves an unknown suggestion uncategorised', async () => {
      const reconcileImport = vi.fn().mockReturnValue(of({ data: { created: 1, skipped: 0 }, error: null }));
      const { component } = configure(makeResult([suggested(999)]), { reconcileImport } as never);

      expect(component.categoryOf(component.rows()[0])).toBeNull();
      await component.submit();
      expect(reconcileImport.mock.calls[0][1][0].categoryId).toBeNull();
    });

    it('resolves a suggestion once the category tree arrives', () => {
      const categories = signal<Category[]>([]);
      const { component } = configure(makeResult([suggested(10)]), {}, categories);
      expect(component.categoryOf(component.rows()[0])).toBeNull();

      categories.set(tree);

      expect(component.categoryOf(component.rows()[0])).toBe(groceries);
    });

    it('submits an accepted suggestion', async () => {
      const reconcileImport = vi.fn().mockReturnValue(of({ data: { created: 1, skipped: 0 }, error: null }));
      const { component } = configure(makeResult([suggested(10)]), { reconcileImport } as never);

      await component.submit();

      expect(reconcileImport.mock.calls[0][1][0].categoryId).toBe(10);
    });
  });

  describe('transfers', () => {
    const ok = () => vi.fn().mockReturnValue(of({ data: { created: 1, skipped: 0 }, error: null }));

    it('starts every row as income or expense', () => {
      const { component } = configure(makeResult([makeRow(0, 'new')]));
      expect(component.rows()[0].transfer).toBe(false);
    });

    it('defaults to another account in the same currency', () => {
      const { component } = configure(makeResult([makeRow(0, 'new')]));
      component.setTransfer(0, true);
      const row = component.rows()[0];
      expect(row.transfer).toBe(true);
      expect(row.transferAccount).toBe(cash);
    });

    it('falls back to an account in another currency', () => {
      const { component } = configure(
        makeResult([makeRow(0, 'new')]), {}, signal(tree), signal([imported, wiseUsd])
      );
      component.setTransfer(0, true);
      expect(component.rows()[0].transferAccount).toBe(wiseUsd);
    });

    it('keeps the category for when the row is switched back', () => {
      const { component } = configure(makeResult([makeRow(0, 'new')]));
      component.setCategory(0, groceries);
      component.setTransfer(0, true);
      component.setTransfer(0, false);
      expect(component.categoryOf(component.rows()[0])).toBe(groceries);
    });

    it('flags a peer in another currency as converted', () => {
      const { component } = configure(makeResult([makeRow(0, 'new')]));
      component.setTransfer(0, true);
      expect(component.isConverted(component.rows()[0])).toBe(false);
      component.setTransferAccount(0, wiseUsd);
      expect(component.isConverted(component.rows()[0])).toBe(true);
    });

    it('sends the peer and no category for a transfer', async () => {
      const reconcileImport = ok();
      const { component } = configure(makeResult([makeRow(0, 'new')]), { reconcileImport } as never);
      component.setCategory(0, groceries);
      component.setTransfer(0, true);

      await component.submit();

      const sent = reconcileImport.mock.calls[0][1][0];
      expect(sent.transferAccountId).toBe(9);
      expect(sent.categoryId).toBeNull();
    });

    it('sends no peer for an income or expense row', async () => {
      const reconcileImport = ok();
      const { component } = configure(makeResult([makeRow(0, 'new')]), { reconcileImport } as never);

      await component.submit();

      expect(reconcileImport.mock.calls[0][1][0].transferAccountId).toBeNull();
    });

    it('blocks import while a selected transfer has no account', async () => {
      const reconcileImport = ok();
      const { component } = configure(
        makeResult([makeRow(0, 'new')]), { reconcileImport } as never, signal(tree), signal([imported])
      );
      component.setTransfer(0, true);

      expect(component.canSubmit()).toBe(false);
      await component.submit();
      expect(reconcileImport).not.toHaveBeenCalled();
    });

    it('ignores an incomplete transfer on an unselected row', () => {
      const { component } = configure(
        makeResult([makeRow(0, 'new'), makeRow(1, 'new')]), {}, signal(tree), signal([imported])
      );
      component.setTransfer(1, true);
      component.toggle(1, false);
      expect(component.canSubmit()).toBe(true);
    });
  });
});
