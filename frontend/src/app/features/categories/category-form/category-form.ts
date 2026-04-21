import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { TuiButton, TuiDataList, TuiDropdown, TuiError, TuiIcon, TuiInput } from '@taiga-ui/core';
import { TuiChevron, TuiInputColor, TuiSelect, TuiTree } from '@taiga-ui/kit';
import { TuiValidationError } from '@taiga-ui/cdk/classes';
import { type TuiHandler, type TuiStringHandler } from '@taiga-ui/cdk';
import { POLYMORPHEUS_CONTEXT } from '@taiga-ui/polymorpheus';
import type { TuiDialogContext } from '@taiga-ui/core';
import { CategoriesState } from '../../../core/categories.state';
import type { Category } from '../../../models/category';
import { findCategoryById } from '../../../models/category';
import { firstValueFrom, pipe } from 'rxjs';
import { TransactionType } from '../../../models/transaction';
import { takeUntilDestroyed, toSignal } from '@angular/core/rxjs-interop';

@Component({
  selector: 'app-category-form',
  imports: [ReactiveFormsModule, TuiInput, TuiInputColor, TuiButton, TuiError, TuiDataList, TuiDropdown, TuiSelect, TuiChevron, TuiTree, TuiIcon],
  templateUrl: './category-form.html',
  styleUrl: './category-form.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CategoryForm {
  private readonly context = inject<TuiDialogContext<Category | null, Category>>(POLYMORPHEUS_CONTEXT);
  private readonly categoriesState = inject(CategoriesState);

  readonly categories = this.categoriesState.categories;

  readonly treeHandler = computed(() => {
    const currentId = this.context.data?.id;
    return (item: Category): readonly Category[] =>
      (item.children || []).filter((c: Category) => c.id !== currentId);
  });

  readonly treeMap = new Map<Category, boolean>();

  readonly parentOptions = computed(() => {
    if (!this.context.data?.id) return this.categories();
    const root_id = this.context.data.root_id;
    return this.categories().filter(c => c.root_id === root_id);
  });

  readonly form = new FormGroup({
    parent: new FormControl<Category | null>(findCategoryById(this.context.data?.parent_id ?? TransactionType.Expense, this.categories()), { nonNullable: true, validators: [Validators.required] }),
    name: new FormControl<string>(this.context.data?.name ?? '', { nonNullable: true, validators: [Validators.required] }),
    color: new FormControl<string>(this.context.data?.color ?? '#14aa00', { nonNullable: true }),
    icon: new FormControl<string>(this.context.data?.icon ?? 'circle', { nonNullable: true }),
  });

  readonly predefinedIcons = [
    'home', 'car', 'shopping-cart', 'heart-pulse', 'briefcase',
    'graduation-cap', 'plane', 'gift', 'music', 'gamepad-2',
    'coffee', 'zap', 'droplets', 'pill', 'briefcase-medical',
    'dumbbell', 'wallet', 'utensils', 'baby', 'star', 'badge-dollar-sign', 'badge-euro', 'badge-russian-ruble'
  ] as const;

  readonly loading = signal(false);
  readonly categoryId = signal(this.context.data?.id ?? null);
  readonly error = signal<TuiValidationError | null>(null);
  readonly parent = toSignal(this.form.controls.parent.valueChanges, { initialValue: this.form.controls.parent.value });

  readonly stringifyCategory: TuiStringHandler<Category | null> = (item) => {
    return item?.fullName ?? 'None (top-level)';
  };
  readonly identityMatcher = (a: Category | null, b: Category | null): boolean => a?.id === b?.id;

  constructor() {
    this.form.controls.parent.valueChanges.pipe(takeUntilDestroyed()).subscribe(parent => this.onParentChange(parent));

    let parent_id = this.form.controls.parent.value?.parent_id;
    while (parent_id) {
      const parent = findCategoryById(parent_id, this.categories());
      if (!parent) break;
      this.treeMap.set(parent, true);
      parent_id = parent.parent_id;
    }
  }

  onParentChange(parent: Category | null): void {
    if (!!this.context.data?.id || !parent) return;
    this.form.controls.color.setValue(parent.color);
    this.form.controls.icon.setValue(parent.icon);
  }

  async onSubmit() {
    if (this.form.invalid) return;

    try {
      this.loading.set(true);
      this.error.set(null);

      const id = this.context.data?.id;
      const { parent, name, color, icon } = this.form.getRawValue();
      const obs = !!id
        ? this.categoriesState.update(id, { name, color, icon })
        : this.categoriesState.create({ name, parentId: parent?.id ?? TransactionType.Expense, color, icon });
      const responce = await firstValueFrom(obs);
      this.context.completeWith(responce.data);
    } catch (err) { }
    finally {
      this.loading.set(false);
    }
  }
}
