import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { CategoriesState } from '../../core/categories.state';
import { TuiTree } from '@taiga-ui/kit';
import { Category, findAncestors, findCategoryById, flattenCategories } from '../../models/category';
import { TuiHandler } from '@taiga-ui/cdk';
import { TuiButton, TuiIcon, TuiLoader } from '@taiga-ui/core';
import { firstValueFrom } from 'rxjs';
import { TransactionType } from '../../models/transaction';
import { CategoryDialogService } from './category-dialog.service';

@Component({
  selector: 'app-categories',
  imports: [TuiTree, TuiIcon, TuiButton, TuiLoader],
  templateUrl: './categories.html',
  styleUrl: './categories.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Categories {
  readonly categoriesState = inject(CategoriesState);
  private readonly categoryDialogs = inject(CategoryDialogService);

  protected readonly handler: TuiHandler<Category, readonly Category[]> = (item) => item.children ?? [];
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
    const category = await this.categoryDialogs.openCreate(parent ?? null);
    if (category !== null) {
      this.selectedId.set(category.id);
    }
  }

  async openDeleteDialog(): Promise<void> {
    const category = this.selectedCategory();
    if (!category || !this.isDeletable()) return;
    const confirmed = await this.categoryDialogs.openDelete(category);
    if (confirmed) {
      await firstValueFrom(this.categoriesState.delete(category.id));
      this.selectedId.set(null);
    }
  }

  async openEditDialog(): Promise<void> {
    const category = this.selectedCategory();
    if (!category || !this.isEditable()) return;
    await this.categoryDialogs.openEdit(category);
  }
}