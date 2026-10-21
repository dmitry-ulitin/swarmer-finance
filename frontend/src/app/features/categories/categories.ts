import { ChangeDetectionStrategy, Component, computed, inject, linkedSignal, signal } from '@angular/core';
import { CategoriesState } from '../../core/categories.state';
import { TuiTree } from '@taiga-ui/kit';
import { Category, findAncestors, findCategoryById, flattenCategories, SystemCategory } from '../../models/category';
import { TuiHandler } from '@taiga-ui/cdk';
import { TuiButton, TuiIcon, TuiLoader } from '@taiga-ui/core';
import { CategoryDialogService } from './category-dialog.service';
import { AuthService } from '../../core/auth.service';

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
  private readonly auth = inject(AuthService);

  protected readonly handler: TuiHandler<Category, readonly Category[]> = (item) => (item.children ?? []).filter((c: Category) => c.user_id !== null);
  readonly categories = computed(() => this.categoriesState.categories().map(c => ({ ...c })));
  readonly selectedId = signal<number | null>(null);
  /**
   * Expanded nodes by id, so the state survives a reload replacing the node
   * objects. The selected category's branch is opened too — once it is in
   * the tree, which for a just-created one is only after the reload.
   */
  private readonly expandedIds = linkedSignal<{ categories: Category[]; selectedId: number | null }, ReadonlySet<number>>({
    source: () => ({ categories: this.categories(), selectedId: this.selectedId() }),
    computation: ({ categories, selectedId }, previous) => {
      const ancestors = (selectedId === null ? null : findAncestors(selectedId, categories)) ?? [];
      return new Set([...(previous?.value ?? []), ...ancestors.map(a => a.id)]);
    },
  });
  /**
   * What the tree reads, keyed by node object. The tree's controller writes
   * a toggle into it too, after `toggled` has already updated `expandedIds`.
   */
  protected readonly map = computed(() => {
    const ids = this.expandedIds();
    return new Map(flattenCategories(this.categories()).filter(c => ids.has(c.id)).map(c => [c, true]));
  });
  readonly selectedCategory = computed(() => findCategoryById(this.selectedId() ?? undefined, this.categories()));
  /**
   * The tree shows one node per path, spanning everyone the user shares
   * accounts with, so a row here may belong to a co-owner. Only the user's
   * own categories can be changed — the backend refuses the rest anyway.
   */
  private readonly isOwn = (category: Category): boolean =>
    category.user_id !== null && category.user_id === this.auth.user()?.id;

  readonly isEditable = computed(() => {
    const selectedCategory = this.selectedCategory();
    return selectedCategory != null && selectedCategory.parent_id !== null && this.isOwn(selectedCategory);
  });
  readonly isDeletable = computed(() => {
    const category = this.selectedCategory();
    // Subcategories move up to the parent; the delete preview reports a clash.
    return category != null && category.parent_id !== null && this.isOwn(category);
  });

  setAsSelected(node: Category) {
    this.selectedId.set(node.id);
  }

  /** Called before the tree flips the node, so its new state is the opposite of the current one. */
  onToggled(node: Category): void {
    const expand = !this.map().get(node);
    this.expandedIds.update(ids => {
      const next = new Set(ids);
      if (expand) next.add(node.id);
      else next.delete(node.id);
      return next;
    });
    const selectedId = this.selectedId();
    if (selectedId === null) return;
    if (findCategoryById(selectedId, node.children ?? [])) {
      this.selectedId.set(null);
    }
  }

  async openCreateDialog(): Promise<void> {
    const parent = this.selectedCategory() || findCategoryById(SystemCategory.Expenses, this.categories());
    const category = await this.categoryDialogs.openCreate(parent ?? null);
    if (category !== null) {
      this.selectedId.set(category.id);
    }
  }

  async openDeleteDialog(): Promise<void> {
    const category = this.selectedCategory();
    if (!category || !this.isDeletable()) return;
    if (await this.categoryDialogs.openDelete(category)) {
      this.selectedId.set(null);
    }
  }

  async openEditDialog(): Promise<void> {
    const category = this.selectedCategory();
    if (!category || !this.isEditable()) return;
    await this.categoryDialogs.openEdit(category);
  }
}