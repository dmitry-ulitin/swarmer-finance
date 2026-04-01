import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { TuiButton, TuiDataList, TuiError, TuiIcon, TuiTextfield } from '@taiga-ui/core';
import { TuiChevron, TuiInputColor, TuiSelect, TuiTree } from '@taiga-ui/kit';
import { TuiValidationError } from '@taiga-ui/cdk/classes';
import { EMPTY_ARRAY, type TuiHandler, type TuiStringHandler } from '@taiga-ui/cdk';
import { POLYMORPHEUS_CONTEXT } from '@taiga-ui/polymorpheus';
import type { TuiDialogContext } from '@taiga-ui/core';
import { CategoriesState } from '../../../core/categories.state';
import type { Category } from '../../../models/category';
import { findCategoryById } from '../../../models/category';
import { firstValueFrom } from 'rxjs';
import { TransactionType } from '../../../models/transaction';
import { toSignal } from '@angular/core/rxjs-interop';

@Component({
  selector: 'app-category-form',
  imports: [ReactiveFormsModule, TuiTextfield, TuiInputColor, TuiButton, TuiError, TuiDataList, TuiSelect, TuiChevron, TuiTree, TuiIcon],
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
      (item.children || EMPTY_ARRAY).filter((c: Category) => c.id !== currentId);
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

  readonly loading = signal(false);
  readonly categoryId = signal(this.context.data?.id ?? null);
  readonly error = signal<TuiValidationError | null>(null);
  readonly parent = toSignal(this.form.controls.parent.valueChanges, { initialValue: this.form.controls.parent.value });
  readonly prefix = computed(() => {
    const parent = this.parent();
    return parent?.parent_id ? `${parent.fullName}/ ` : '';
  });

  readonly stringifyCategory: TuiStringHandler<Category | null> = (item) => {
    return item?.name ?? 'None (top-level)';
  };
  readonly identityMatcher = (a: Category | null, b: Category | null): boolean => a?.id === b?.id;

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
