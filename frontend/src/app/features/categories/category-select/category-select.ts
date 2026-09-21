import { ChangeDetectionStrategy, Component, computed, forwardRef, inject, input } from '@angular/core';
import { ControlValueAccessor, FormsModule, NG_VALUE_ACCESSOR } from '@angular/forms';
import { TuiDataList, TuiIcon, TuiTextfield } from '@taiga-ui/core';
import { TuiChevron, TuiSelect, TuiTree } from '@taiga-ui/kit';
import { type TuiStringHandler } from '@taiga-ui/cdk';
import { CategoriesState } from '../../../core/categories.state';
import { AuthService } from '../../../core/auth.service';
import type { Category } from '../../../models/category';

/**
 * Picks a category from the tree under one root (1 = Income, 2 = Expenses).
 *
 * Shared between the transaction form and statement import, which need
 * identical behaviour: both can show categories owned by someone else, since
 * a shared account's transactions carry their author's categories.
 */
@Component({
  selector: 'app-category-select',
  imports: [FormsModule, TuiTextfield, TuiSelect, TuiDataList, TuiTree, TuiIcon, TuiChevron],
  templateUrl: './category-select.html',
  styleUrl: './category-select.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
  providers: [
    {
      provide: NG_VALUE_ACCESSOR,
      useExisting: forwardRef(() => CategorySelect),
      multi: true,
    },
  ],
})
export class CategorySelect implements ControlValueAccessor {
  /** 1 for Income, 2 for Expenses. */
  readonly rootId = input.required<number>();
  readonly label = input<string>('Category');
  readonly cleaner = input<boolean>(true);

  private readonly categoriesState = inject(CategoriesState);
  private readonly auth = inject(AuthService);

  protected value: Category | null = null;
  protected disabled = false;
  private onChange: (value: Category | null) => void = () => {};
  protected onTouched: () => void = () => {};

  readonly visibleCategories = computed(
    () => this.categoriesState.categories().find(c => c.id === this.rootId())?.children ?? []
  );

  /**
   * A category owned by someone else — shown because a shared account's
   * transactions carry their author's categories. Picking one is allowed:
   * the server copies the path into the owner's own tree.
   */
  readonly isForeign = (c: Category): boolean =>
    c.user_id !== null && c.user_id !== this.auth.user()?.id;

  readonly stringify: TuiStringHandler<Category | null> = c =>
    c?.fullName ?? c?.name ?? 'Uncategorized';

  // The tree holds one node per path, so a transaction may reference a row
  // that lost the dedupe to an equivalent one. Identity is the path, not the
  // id, or such a category would not highlight in the dropdown.
  readonly categoryMatcher = (a: Category | null, b: Category | null): boolean =>
    a?.root_id === b?.root_id && a?.fullName === b?.fullName;

  readonly treeMap = new Map<Category, boolean>();
  readonly treeHandler = (item: Category): readonly Category[] => item.children ?? [];

  writeValue(value: Category | null): void {
    this.value = value;
  }

  registerOnChange(fn: (value: Category | null) => void): void {
    this.onChange = fn;
  }

  registerOnTouched(fn: () => void): void {
    this.onTouched = fn;
  }

  setDisabledState(disabled: boolean): void {
    this.disabled = disabled;
  }

  protected onValueChange(value: Category | null): void {
    this.value = value;
    this.onChange(value);
  }
}
