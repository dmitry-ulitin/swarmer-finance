import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { TuiButton, TuiDataList, TuiDropdown, TuiIcon, TuiInput } from '@taiga-ui/core';
import { TuiChevron, TuiInputColor, TuiSelect, TuiTree } from '@taiga-ui/kit';
import { TuiAutoFocus, type TuiStringHandler } from '@taiga-ui/cdk';
import { POLYMORPHEUS_CONTEXT } from '@taiga-ui/polymorpheus';
import type { TuiDialogContext } from '@taiga-ui/core';
import { firstValueFrom } from 'rxjs';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';
import { CategoriesState } from '../../../core/categories.state';
import { NotificationService } from '../../../core/notification.service';
import { findAncestors, findCategoryById, type Category } from '../../../models/category';
import { TransactionType } from '../../../models/transaction';

/** What the category dialog works on: an existing category, or a new one. */
export interface CategoryFormData {
  /** The category to edit; absent when creating one. */
  category?: Category;
  /** The parent a new category starts under; defaults to the root. */
  parent?: Category | null;
  /** Keeps a new category under one root (1 = Income, 2 = Expenses). */
  rootId?: number;
}

const PREDEFINED_ICONS = [
  'home', 'car', 'fuel', 'wrench', 'shopping-cart', 'shirt', 'shopping-basket', 'percent', 'briefcase',
  'graduation-cap', 'bus','plane', 'ship', 'tree-palm', 'gift', 'music', 'gamepad-2',
  'zap', 'droplets', 'heart-pulse', 'pill', 'briefcase-medical',
  'dumbbell', 'cat', 'wallet', 'hand-coins', 'utensils', 'coffee', 'soup', 'bottle-wine', 'baby', 'fish',
  'star', 'playing-cards-fan', 'party-popper', 'cake', 'badge-dollar-sign', 'badge-euro', 'badge-russian-ruble'
];

@Component({
  selector: 'app-category-form',
  imports: [ReactiveFormsModule, TuiInput, TuiInputColor, TuiButton, TuiDataList, TuiDropdown, TuiSelect, TuiChevron, TuiTree, TuiIcon, TuiAutoFocus],
  templateUrl: './category-form.html',
  styleUrl: './category-form.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CategoryForm {
  private readonly context = inject<TuiDialogContext<Category | null, CategoryFormData>>(POLYMORPHEUS_CONTEXT);
  private readonly categoriesState = inject(CategoriesState);
  private readonly notifications = inject(NotificationService);

  private readonly editing = this.context.data.category ?? null;
  readonly isEdit = this.editing !== null;
  private readonly rootId = this.editing?.root_id ?? this.context.data.rootId ?? null;
  private readonly categories = this.categoriesState.categories;

  /** The roots a parent can be picked under: just the category's own when it is fixed. */
  readonly parentOptions = computed(() =>
    this.rootId === null ? this.categories() : this.categories().filter(c => c.id === this.rootId)
  );
  /** User categories only, and never the edited one itself. */
  readonly treeHandler = (item: Category): readonly Category[] =>
    (item.children ?? []).filter(c => c.id !== this.editing?.id && c.user_id !== null);
  readonly treeMap = new Map<Category, boolean>();

  private readonly initialParent = this.editing
    ? findCategoryById(this.editing.parent_id ?? undefined, this.categories())
    : this.context.data.parent ?? findCategoryById(this.rootId ?? TransactionType.Expense, this.categories());

  readonly form = new FormGroup({
    parent: new FormControl<Category | null>(this.initialParent, { nonNullable: true, validators: [Validators.required] }),
    name: new FormControl<string>(this.editing?.name ?? '', { nonNullable: true, validators: [Validators.required] }),
    color: new FormControl<string>(this.editing?.color ?? this.initialParent?.color ?? '#14aa00', { nonNullable: true }),
    icon: new FormControl<string>(this.editing?.icon ?? this.initialParent?.icon ?? 'circle', { nonNullable: true }),
  });

  readonly loading = signal(false);
  private readonly parent = toSignal(this.form.controls.parent.valueChanges, { initialValue: this.form.controls.parent.value });
  /** The predefined icons, led by the plus / minus sign of the parent's root. */
  readonly icons = computed(() => {
    const root = this.parent()?.root_id;
    const sign = root === TransactionType.Income ? ['circle-plus'] : root === TransactionType.Expense ? ['circle-minus'] : [];
    return [...sign, ...PREDEFINED_ICONS];
  });

  readonly stringifyCategory: TuiStringHandler<Category | null> = item => item?.fullName || item?.name || 'None (top-level)';
  readonly identityMatcher = (a: Category | null, b: Category | null): boolean => a?.id === b?.id;

  constructor() {
    const c = this.form.controls;
    // An edit keeps the category where it is: the API cannot move it.
    if (this.isEdit) {
      c.parent.disable();
    } else {
      // A new category takes its parent's look until the user picks one.
      c.parent.valueChanges.pipe(takeUntilDestroyed()).subscribe(parent => {
        if (!parent) return;
        c.color.setValue(parent.color);
        c.icon.setValue(parent.icon);
      });
    }

    const parent = c.parent.value;
    for (const ancestor of (parent && findAncestors(parent.id, this.categories())) ?? []) {
      this.treeMap.set(ancestor, true);
    }
  }

  cancel(): void {
    this.context.completeWith(null);
  }

  async onSubmit(): Promise<void> {
    if (this.form.invalid) return;

    try {
      this.loading.set(true);
      const { parent, name, color, icon } = this.form.getRawValue();
      const request = this.editing
        ? this.categoriesState.update(this.editing.id, { name, color, icon })
        : this.categoriesState.create({ name, parentId: parent?.id ?? TransactionType.Expense, color, icon });
      const response = await firstValueFrom(request);
      this.context.completeWith(response.data);
    } catch (e) {
      this.notifications.showError(e, 'Failed to save category');
    } finally {
      this.loading.set(false);
    }
  }
}
