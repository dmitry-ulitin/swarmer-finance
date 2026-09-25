import { inject, Injectable, INJECTOR } from '@angular/core';
import { TUI_CONFIRM, TuiConfirmData } from '@taiga-ui/kit';
import { tuiDialog, TuiDialogService } from '@taiga-ui/core';
import { PolymorpheusComponent } from '@taiga-ui/polymorpheus';
import { firstValueFrom } from 'rxjs';
import type { Category } from '../../models/category';
import { CategoriesState } from '../../core/categories.state';
import { NotificationService } from '../../core/notification.service';

@Injectable({ providedIn: 'root' })
export class CategoryDialogService {
  private readonly dialogs = inject(TuiDialogService);
  private readonly injector = inject(INJECTOR);
  private readonly categoriesState = inject(CategoriesState);
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

  async openCreate(parent: Category | null): Promise<Category | null> {
    try {
      const { CategoryForm } = await import('./category-form/category-form');
      return await firstValueFrom(
        this.dialogs.open<Category | null>(
          new PolymorpheusComponent(CategoryForm, this.injector),
          {
            data: { ...parent, id: null, name: '', parent_id: parent?.id, children: [] },
            label: 'Add Category',
            size: 's',
          }
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
      await firstValueFrom(
        this.dialogs.open<Category | null>(
          new PolymorpheusComponent(CategoryForm, this.injector),
          { data: category, label: 'Edit Category', size: 's' }
        ),
        { defaultValue: null }
      );
    } catch (e) {
      this.notifications.showError(e, 'Failed to open category form');
    }
  }

  async openDelete(category: Category): Promise<boolean> {
    const data: TuiConfirmData = {
      content: `Delete "${category.name}"?`,
      yes: 'Delete',
      no: 'Cancel',
    };
    try {
      const confirmed = await firstValueFrom(
        this.dialogs.open<boolean>(TUI_CONFIRM, { label: 'Delete Category', size: 's', data }),
        { defaultValue: false }
      );
      if (!confirmed) return false;
      await firstValueFrom(this.categoriesState.delete(category.id));
      return true;
    } catch (e) {
      this.notifications.showError(e, 'Failed to delete category');
      return false;
    }
  }
}
