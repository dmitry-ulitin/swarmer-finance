import { ChangeDetectionStrategy, Component, computed, inject, INJECTOR, signal } from '@angular/core';
import { CategoriesState } from '../../core/categories.state';
import { TUI_CONFIRM, TuiConfirmData, TuiTree } from '@taiga-ui/kit';
import { Category, findAncestors, findCategoryById, flattenCategories } from '../../models/category';
import { EMPTY_ARRAY, TuiHandler } from '@taiga-ui/cdk';
import { TuiButton, TuiDialogService, TuiIcon, TuiLoader } from '@taiga-ui/core';
import { PolymorpheusComponent } from '@taiga-ui/polymorpheus';
import { firstValueFrom } from 'rxjs';
import { TransactionType } from '../../models/transaction';

@Component({
  selector: 'app-categories',
  imports: [TuiTree, TuiIcon, TuiButton, TuiLoader],
  templateUrl: './categories.html',
  styleUrl: './categories.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Categories {
  readonly categoriesState = inject(CategoriesState);
  private readonly dialogs = inject(TuiDialogService);
  private readonly injector = inject(INJECTOR);

  protected readonly handler: TuiHandler<Category, readonly Category[]> = (item) => item.children || EMPTY_ARRAY;
  protected readonly map = new Map<Category, boolean>();
  readonly categories = computed(() => {
    const newCategories = this.categoriesState.categories();
    const expandedIds = new Set<number>();
    this.map.forEach((expanded, category) => {
      if (expanded) expandedIds.add(category.id);
    });
    this.map.clear();
    flattenCategories(newCategories).forEach(cat => {
      if (expandedIds.has(cat.id)) {
        this.map.set(cat, true);
      }
    });
    return newCategories;
  });
  readonly selectedId = signal<number | null>(null);
  readonly selectedCategory = computed(() => {
    const selectedId = this.selectedId();
    if (selectedId === null) return null;
    const categories = this.categories();
    const ancestors = findAncestors(selectedId, categories);
    ancestors?.forEach(ancestor => this.map.set(ancestor, true));
    return findCategoryById(selectedId, categories);
  });
  readonly isEditable = computed(() => {
    const selectedCategory = this.selectedCategory();
    return selectedCategory != null && selectedCategory.parent_id !== null;
  });
  readonly isDeletable = computed(() => {
    const category = this.selectedCategory();
    return category != null && category.parent_id !== null && (category.children?.length ?? 0) === 0;
  });

  setAsSelected(node: Category) {
    this.selectedId.set(node.id);
  }

  onToggled(node: Category): void {
    const selectedId = this.selectedId();
    if (selectedId === null) return;
    if (findCategoryById(selectedId, node.children ?? [])) {
      this.selectedId.set(null);
    }
  }

  async openCreateDialog(): Promise<void> {
    const parent = this.selectedCategory() || findCategoryById(TransactionType.Expense, this.categories());
    const { CategoryForm } = await import('./category-form/category-form');
    const category = await firstValueFrom(this.dialogs.open<Category | null>(
      new PolymorpheusComponent(CategoryForm, this.injector),
      {
        data: { ...parent, id: null, name: '', parent_id: parent?.id, children: [] },
        label: 'Add Category',
        size: 's',
      }
    ), { defaultValue: null });
    if (category !== null) {
      this.selectedId.set(category.id);
    }
  }

  async openDeleteDialog(): Promise<void> {
    const category = this.selectedCategory();
    if (!category || !this.isDeletable()) return;
    const data: TuiConfirmData = {
      content: `Delete "${category?.name}"?`,
      yes: 'Delete',
      no: 'Cancel',
    };
    const confirmed = await firstValueFrom(
      this.dialogs.open<boolean>(TUI_CONFIRM, { label: 'Delete Category', size: 's', data }),
      { defaultValue: false }
    );
    if (confirmed) {
      await firstValueFrom(this.categoriesState.delete(category.id));
      this.selectedId.set(null);
    }
  }

  async openEditDialog(): Promise<void> {
    const category = this.selectedCategory();
    if (!category || !this.isEditable()) return;
    const { CategoryForm } = await import('./category-form/category-form');
    await firstValueFrom(this.dialogs.open<Category | null>(
      new PolymorpheusComponent(CategoryForm, this.injector),
      {
        data: category,
        label: 'Edit Category',
        size: 's',
      }
    ), { defaultValue: null });
  }
}