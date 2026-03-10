import { ChangeDetectionStrategy, Component, computed, inject, INJECTOR, signal } from '@angular/core';
import { CategoriesState } from '../../core/categories.state';
import { TuiTree } from '@taiga-ui/kit';
import { Category } from '../../models/category';
import { EMPTY_ARRAY, TuiHandler } from '@taiga-ui/cdk';
import { TuiButton, TuiDialogService, TuiIcon, TuiLoader } from '@taiga-ui/core';
import { PolymorpheusComponent } from '@taiga-ui/polymorpheus';
import type { CategoryDialogInput } from './category-form/category-form';

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
    const categories = this.categoriesState.categories();
    const visit = (items: Category[]) => {
      for (const item of items) {
        const key = [...this.map.keys()].find(n => n.id === item.id);
        if (key) {
          this.map.set(item, this.map.get(key) || false);
          this.map.delete(key);
        }

        if (item.children?.length) visit(item.children);
      }
    };
    visit(categories);
    return categories;
  });


  setAsSelected(node: Category) {
    this.selected.set(node.id);
  }

  async openCreateDialog(): Promise<void> {
    const { CategoryForm } = await import('./category-form/category-form');
    this.dialogs.open<void>(
      new PolymorpheusComponent(CategoryForm, this.injector),
      {
        data: { categories: this.categories() } satisfies CategoryDialogInput,
        label: 'Add Category',
        size: 's',
      }
    ).subscribe();
  }

  async openEditDialog(): Promise<void> {
    const selectedId = this.selected();
    if (!selectedId) return;
    const category = this.findCategoryById(selectedId, this.categories());
    if (!category) return;
    const { CategoryForm } = await import('./category-form/category-form');
    this.dialogs.open<void>(
      new PolymorpheusComponent(CategoryForm, this.injector),
      {
        data: { category, categories: this.categories() } satisfies CategoryDialogInput,
        label: 'Edit Category',
        size: 's',
      }
    ).subscribe();
  }

  private findCategoryById(id: number, categories: Category[]): Category | null {
    for (const category of categories) {
      if (category.id === id) {
        return category;
      }
      if (category.children) {
        const found = this.findCategoryById(id, category.children);
        if (found) {
          return found;
        }
      }
    }
    return null;
  }
}