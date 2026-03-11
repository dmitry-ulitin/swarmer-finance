import { ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { TuiButton, TuiDataList, TuiError, TuiTextfield } from '@taiga-ui/core';
import { TuiChevron, TuiDataListWrapper, TuiSelect } from '@taiga-ui/kit';
import { TuiValidationError } from '@taiga-ui/cdk/classes';
import type { TuiStringHandler } from '@taiga-ui/cdk';
import { POLYMORPHEUS_CONTEXT } from '@taiga-ui/polymorpheus';
import type { TuiDialogContext } from '@taiga-ui/core';
import { CategoriesState } from '../../../core/categories.state';
import type { Category } from '../../../models/category';

export interface CategoryDialogInput {
  category?: Category;
  categories: Category[];
}

@Component({
  selector: 'app-category-form',
  imports: [ReactiveFormsModule, TuiTextfield, TuiButton, TuiError, TuiDataList, TuiSelect, TuiChevron, TuiDataListWrapper],
  templateUrl: './category-form.html',
  styleUrl: './category-form.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CategoryForm {
  private readonly context = inject<TuiDialogContext<void, CategoryDialogInput>>(POLYMORPHEUS_CONTEXT);
  private readonly categoriesState = inject(CategoriesState);

  readonly isEdit = !!this.context.data.category;
  readonly flatCategories = this.context.data.categories;

  readonly form = new FormGroup({
    name: new FormControl<string>('', { nonNullable: true, validators: [Validators.required] }),
    parentId: new FormControl<number | null>(null),
    color: new FormControl<string>('#6366f1', { nonNullable: true }),
    icon: new FormControl<string>('circle', { nonNullable: true }),
  });

  readonly loading = signal(false);
  readonly error = signal<TuiValidationError | null>(null);

  readonly stringifyCategory: TuiStringHandler<number | null> = (id) => {
    if (id === null) return 'None (top-level)';
    return this.flatCategories.find((c) => c.id === id)?.name ?? String(id);
  };

  constructor() {
    const category = this.context.data.category;
    if (category) {
      this.form.setValue({
        name: category.name,
        parentId: category.parent_id,
        color: category.color,
        icon: category.icon,
      });
    }
  }

  onSubmit(): void {
    if (this.form.invalid) return;

    this.loading.set(true);
    this.error.set(null);

    const { name, parentId, color, icon } = this.form.getRawValue();
    const obs = this.isEdit
      ? this.categoriesState.update(this.context.data.category!.id, { name, color, icon })
      : this.categoriesState.create({ name, parentId: parentId ?? 0, color, icon });

    obs.subscribe({
      next: () => {
        this.context.completeWith(undefined);
      },
      error: (err: unknown) => {
        this.loading.set(false);
        const msg = (err as { error?: { error?: string } })?.error?.error ?? 'Something went wrong';
        this.error.set(new TuiValidationError(msg));
      },
    });
  }
}
