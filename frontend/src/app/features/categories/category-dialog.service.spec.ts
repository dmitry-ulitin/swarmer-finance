import { TestBed } from '@angular/core/testing';
import { TuiDialogService } from '@taiga-ui/core';
import { of, throwError } from 'rxjs';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CategoryDialogService, deleteMessage } from './category-dialog.service';
import { CategoriesState } from '../../core/categories.state';
import { NotificationService } from '../../core/notification.service';
import { TransactionsState } from '../../core/transactions.state';
import type { Category, CategoryDeletePreview } from '../../models/category';

const category: Category = {
  id: 7, user_id: 1, name: 'Food', parent_id: 2, color: '', icon: '', created_at: '',
  owner_name: null, fullName: 'Food', root_id: 2,
};

const emptyPreview: CategoryDeletePreview = {
  transactions: 0, subcategories: 0, transactionsTo: 'Uncategorized', subcategoriesTo: 'Expenses', conflicts: [],
};

describe('deleteMessage', () => {
  it('asks politely when nothing else is affected', () => {
    expect(deleteMessage(category, emptyPreview)).toBe('Are you sure you want to delete "Food"?');
  });

  it('says where transactions and subcategories go', () => {
    expect(deleteMessage(category, { ...emptyPreview, transactions: 12, subcategories: 1 })).toBe(
      'Are you sure you want to delete "Food"? 12 transactions will be moved to "Uncategorized". ' +
        '1 subcategory will be moved under "Expenses".'
    );
  });
});

describe('CategoryDialogService.openDelete', () => {
  let service: CategoryDialogService;
  let dialogOpen: ReturnType<typeof vi.fn>;
  let deleteCategory: ReturnType<typeof vi.fn>;
  let deletePreview: ReturnType<typeof vi.fn>;
  let reload: ReturnType<typeof vi.fn>;
  let showError: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    dialogOpen = vi.fn(() => of(true));
    deleteCategory = vi.fn(() => of({ data: null, error: null }));
    deletePreview = vi.fn(() => of({ data: emptyPreview, error: null }));
    reload = vi.fn();
    showError = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        { provide: TuiDialogService, useValue: { open: dialogOpen } },
        { provide: CategoriesState, useValue: { delete: deleteCategory, deletePreview } },
        { provide: NotificationService, useValue: { showError } },
        { provide: TransactionsState, useValue: { reload } },
      ],
    });
    service = TestBed.inject(CategoryDialogService);
  });

  it('deletes the category once confirmed', async () => {
    expect(await service.openDelete(category)).toBe(true);
    expect(deletePreview).toHaveBeenCalledWith(7);
    expect(deleteCategory).toHaveBeenCalledWith(7);
    expect(showError).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
  });

  it('reloads the transactions when some were moved', async () => {
    deletePreview.mockReturnValue(of({ data: { ...emptyPreview, transactions: 3 }, error: null }));
    expect(await service.openDelete(category)).toBe(true);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('refuses without deleting when a subcategory name is taken', async () => {
    deletePreview.mockReturnValue(of({ data: { ...emptyPreview, conflicts: ['Streaming'] }, error: null }));
    dialogOpen.mockReturnValue(of(undefined));
    expect(await service.openDelete(category)).toBe(false);
    expect(dialogOpen).toHaveBeenCalledWith(
      expect.stringContaining('already has a subcategory named "Streaming"'),
      expect.objectContaining({ label: 'Cannot Delete Category' })
    );
    expect(deleteCategory).not.toHaveBeenCalled();
  });

  it('does not delete when cancelled', async () => {
    dialogOpen.mockReturnValue(of(false));
    expect(await service.openDelete(category)).toBe(false);
    expect(deleteCategory).not.toHaveBeenCalled();
  });

  it('reports a failed delete instead of rejecting', async () => {
    const err = new Error('boom');
    deleteCategory.mockReturnValue(throwError(() => err));
    expect(await service.openDelete(category)).toBe(false);
    expect(showError).toHaveBeenCalledWith(err, 'Failed to delete category');
  });
});

describe('CategoryDialogService.openEdit', () => {
  let service: CategoryDialogService;
  let dialogOpen: ReturnType<typeof vi.fn>;
  let reload: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    dialogOpen = vi.fn(() => of(category));
    reload = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        { provide: TuiDialogService, useValue: { open: dialogOpen } },
        { provide: CategoriesState, useValue: {} },
        { provide: NotificationService, useValue: { showError: vi.fn() } },
        { provide: TransactionsState, useValue: { reload } },
      ],
    });
    service = TestBed.inject(CategoryDialogService);
  });

  it('reloads the transactions and the summary once saved', async () => {
    await service.openEdit(category);
    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('does not reload when cancelled', async () => {
    dialogOpen.mockReturnValue(of(null));
    await service.openEdit(category);
    expect(reload).not.toHaveBeenCalled();
  });
});
