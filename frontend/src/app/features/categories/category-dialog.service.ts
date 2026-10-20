import { inject, Injectable, INJECTOR } from '@angular/core';
import { TUI_CONFIRM, TuiConfirmData } from '@taiga-ui/kit';
import { tuiDialog, TuiDialogService } from '@taiga-ui/core';
import { PolymorpheusComponent } from '@taiga-ui/polymorpheus';
import { firstValueFrom } from 'rxjs';
import type { Category, CategoryDeletePreview } from '../../models/category';
import type { CategoryFormData } from './category-form/category-form';
import { CategoriesState } from '../../core/categories.state';
import { TransactionsState } from '../../core/transactions.state';
import { NotificationService } from '../../core/notification.service';

@Injectable({ providedIn: 'root' })
export class CategoryDialogService {
  private readonly dialogs = inject(TuiDialogService);
  private readonly injector = inject(INJECTOR);
  private readonly categoriesState = inject(CategoriesState);
  private readonly transactions = inject(TransactionsState);
  private readonly notifications = inject(NotificationService);

  async openManager(): Promise<void> {
    try {
      const { Categories } = await import('./categories');
      await firstValueFrom(
        tuiDialog(Categories, { injector: this.injector, label: 'Categories', size: 'l' })(),
        { defaultValue: null }
      );
    } catch (e) {
      this.notifications.showError(e, 'Failed to open categories');
    }
  }

  /** Creates a category under `parent`; `rootId` keeps it to Income (1) or Expenses (2). */
  async openCreate(parent: Category | null, rootId?: number): Promise<Category | null> {
    try {
      const { CategoryForm } = await import('./category-form/category-form');
      const data: CategoryFormData = { parent, rootId };
      return await firstValueFrom(
        this.dialogs.open<Category | null>(
          new PolymorpheusComponent(CategoryForm, this.injector),
          { data, label: 'Add Category', size: 's' }
        ),
        { defaultValue: null }
      );
    } catch (e) {
      this.notifications.showError(e, 'Failed to open category form');
      return null;
    }
  }

  async openEdit(category: Category): Promise<void> {
    try {
      const { CategoryForm } = await import('./category-form/category-form');
      const saved = await firstValueFrom(
        this.dialogs.open<Category | null>(
          new PolymorpheusComponent(CategoryForm, this.injector),
          { data: { category } satisfies CategoryFormData, label: 'Edit Category', size: 's' }
        ),
        { defaultValue: null }
      );
      // A rename or a move changes the paths the transactions and the
      // summary show.
      if (saved) this.transactions.reload();
    } catch (e) {
      this.notifications.showError(e, 'Failed to open category form');
    }
  }

  async openDelete(category: Category): Promise<boolean> {
    try {
      const preview = (await firstValueFrom(this.categoriesState.deletePreview(category.id))).data!;
      if (preview.conflicts.length > 0) {
        await firstValueFrom(
          this.dialogs.open(
            `"${preview.subcategoriesTo}" already has a subcategory named "${preview.conflicts[0]}". ` +
              `Please rename one of them before deleting "${category.name}".`,
            { label: 'Cannot Delete Category', size: 's' }
          ),
          { defaultValue: undefined }
        );
        return false;
      }
      const data: TuiConfirmData = {
        content: deleteMessage(category, preview),
        yes: 'Delete',
        no: 'Cancel',
      };
      const confirmed = await firstValueFrom(
        this.dialogs.open<boolean>(TUI_CONFIRM, { label: 'Delete Category', size: 's', data }),
        { defaultValue: false }
      );
      if (!confirmed) return false;
      await firstValueFrom(this.categoriesState.delete(category.id));
      // Moved transactions and subcategories change the paths the
      // transactions and the summary show.
      if (preview.transactions > 0 || preview.subcategories > 0) this.transactions.reload();
      return true;
    } catch (e) {
      this.notifications.showError(e, 'Failed to delete category');
      return false;
    }
  }
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** The confirmation text, saying where the category's contents will go. */
export const deleteMessage = (category: Category, preview: CategoryDeletePreview): string => {
  let message = `Are you sure you want to delete "${category.name}"?`;
  if (preview.transactions > 0) {
    message += ` ${plural(preview.transactions, 'transaction', 'transactions')} will be moved to "${preview.transactionsTo}".`;
  }
  if (preview.subcategories > 0) {
    message += ` ${plural(preview.subcategories, 'subcategory', 'subcategories')} will be moved under "${preview.subcategoriesTo}".`;
  }
  return message;
};
