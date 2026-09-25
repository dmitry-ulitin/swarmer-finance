import { TestBed } from '@angular/core/testing';
import { TuiDialogService } from '@taiga-ui/core';
import { of, throwError } from 'rxjs';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { CategoryDialogService } from './category-dialog.service';
import { CategoriesState } from '../../core/categories.state';
import { NotificationService } from '../../core/notification.service';
import type { Category } from '../../models/category';

const category: Category = {
  id: 7, user_id: 1, name: 'Food', parent_id: 2, color: '', icon: '', created_at: '',
  owner_name: null, fullName: 'Food', root_id: 2,
};

describe('CategoryDialogService.openDelete', () => {
  let service: CategoryDialogService;
  let dialogOpen: ReturnType<typeof vi.fn>;
  let deleteCategory: ReturnType<typeof vi.fn>;
  let showError: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    dialogOpen = vi.fn(() => of(true));
    deleteCategory = vi.fn(() => of({ data: null, error: null }));
    showError = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        { provide: TuiDialogService, useValue: { open: dialogOpen } },
        { provide: CategoriesState, useValue: { delete: deleteCategory } },
        { provide: NotificationService, useValue: { showError } },
      ],
    });
    service = TestBed.inject(CategoryDialogService);
  });

  it('deletes the category once confirmed', async () => {
    expect(await service.openDelete(category)).toBe(true);
    expect(deleteCategory).toHaveBeenCalledWith(7);
    expect(showError).not.toHaveBeenCalled();
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
