import { ChangeDetectionStrategy, Component, computed, inject, INJECTOR, signal } from '@angular/core';
import { CategoriesState } from '../../core/categories.state';
import { TuiTree } from '@taiga-ui/kit';
import { Category, findCategoryById, flattenCategories } from '../../models/category';
import { EMPTY_ARRAY, TuiHandler } from '@taiga-ui/cdk';
import { TuiButton, TuiDialogService, TuiIcon, TuiLoader } from '@taiga-ui/core';
import { PolymorpheusComponent } from '@taiga-ui/polymorpheus';
import { TransactionType } from '../../models/transaction';
import { firstValueFrom } from 'rxjs';

@Component({
  selector: 'app-categories',
  imports: [TuiTree, TuiIcon, TuiButton, TuiLoader],
  templateUrl: './categories.html',
  styleUrl: './categories.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Categories {
  categoriesState = inject(CategoriesState);
  private readonly dialogs = inject(TuiDialogService);
  private readonly injector = inject(INJECTOR);

  protected readonly handler: TuiHandler<Category, readonly Category[]> = (item) => item.children || EMPTY_ARRAY;
  selected = signal<number | null>(null);
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


  setAsSelected(node: Category) {
    this.selected.set(node.id);
  }

  onToggled(node: Category): void {
    const selectedId = this.selected();
    if (selectedId === null) return;
    if (findCategoryById(selectedId, node.children ?? [])) {
      this.selected.set(null);
    }
  }

  async openCreateDialog(): Promise<void> {
    const selectedId = this.selected() ?? TransactionType.Expense;
    const parent = findCategoryById(selectedId, this.categories());
    if (parent == null) return;
    const { CategoryForm } = await import('./category-form/category-form');
    const category = await firstValueFrom(this.dialogs.open<Category | null>(
      new PolymorpheusComponent(CategoryForm, this.injector),
      {
        data: { ...parent, id: null, name: '', parent_id: parent.id, children: [] },
        label: 'Add Category',
        size: 's',
      }
    ), { defaultValue: null });
    if (category !== null) {
      this.selected.set(category.id);
    }
  }

  async openEditDialog(): Promise<void> {
    const selectedId = this.selected();
    if (!selectedId) return;
    const category = findCategoryById(selectedId, this.categories());
    if (!category) return;
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