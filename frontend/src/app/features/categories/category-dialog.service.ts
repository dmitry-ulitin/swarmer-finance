import { inject, Injectable, INJECTOR } from '@angular/core';
import { TUI_CONFIRM, TuiConfirmData } from '@taiga-ui/kit';
import { tuiDialog, TuiDialogService } from '@taiga-ui/core';
import { PolymorpheusComponent } from '@taiga-ui/polymorpheus';
import { firstValueFrom } from 'rxjs';
import type { Category } from '../../models/category';

@Injectable({ providedIn: 'root' })
export class CategoryDialogService {
  private readonly dialogs = inject(TuiDialogService);
  private readonly injector = inject(INJECTOR);

  async openManager(): Promise<void> {
    const { Categories } = await import('./categories');
    await firstValueFrom(
      tuiDialog(Categories, { injector: this.injector, label: 'Categories', size: 'l' })(),
      { defaultValue: null }
    );
  }

  async openCreate(parent: Category | null): Promise<Category | null> {
    const { CategoryForm } = await import('./category-form/category-form');
    return firstValueFrom(
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
  }

  async openEdit(category: Category): Promise<void> {
    const { CategoryForm } = await import('./category-form/category-form');
    await firstValueFrom(
      this.dialogs.open<Category | null>(
        new PolymorpheusComponent(CategoryForm, this.injector),
        { data: category, label: 'Edit Category', size: 's' }
      ),
      { defaultValue: null }
    );
  }

  async openDelete(category: Category): Promise<boolean> {
    const data: TuiConfirmData = {
      content: `Delete "${category.name}"?`,
      yes: 'Delete',
      no: 'Cancel',
    };
    return firstValueFrom(
      this.dialogs.open<boolean>(TUI_CONFIRM, { label: 'Delete Category', size: 's', data }),
      { defaultValue: false }
    );
  }
}
