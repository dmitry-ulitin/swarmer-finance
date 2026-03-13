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
import { TransactionType } from '../../../models/transaction';
import { firstValueFrom } from 'rxjs';

@Component({
  selector: 'app-category-form',
  imports: [ReactiveFormsModule, TuiTextfield, TuiButton, TuiError, TuiDataList, TuiSelect, TuiChevron, TuiDataListWrapper],
  templateUrl: './category-form.html',
  styleUrl: './category-form.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CategoryForm {
  private readonly context = inject<TuiDialogContext<Category | null, Category>>(POLYMORPHEUS_CONTEXT);
  private readonly categoriesState = inject(CategoriesState);

  readonly categories = this.categoriesState.categories();

  readonly form = new FormGroup({
    id: new FormControl<number | null>(this.context.data?.id),
    name: new FormControl<string>(this.context.data?.name ?? '', { nonNullable: true, validators: [Validators.required] }),
    parentId: new FormControl<number | null>(this.context.data?.parent_id ?? TransactionType.Income),
    color: new FormControl<string>(this.context.data?.color ?? '#14aa00', { nonNullable: true }),
    icon: new FormControl<string>(this.context.data?.icon ?? 'circle', { nonNullable: true }),
  });

  readonly loading = signal(false);
  readonly error = signal<TuiValidationError | null>(null);

  readonly stringifyCategory: TuiStringHandler<number | null> = (id) => {
    if (id === null) return 'None (top-level)';
    return this.categories.find((c) => c.id === id)?.name ?? String(id);
  };

  constructor() { }

  async onSubmit() {
    if (this.form.invalid) return;

    try {
      this.loading.set(true);
      this.error.set(null);

      const { id, name, parentId, color, icon } = this.form.getRawValue();
      const obs = !!id
        ? this.categoriesState.update(id, { name, color, icon })
        : this.categoriesState.create({ name, parentId: parentId ?? 0, color, icon });
      const responce = await firstValueFrom(obs);
      this.context.completeWith(responce.data);
    } catch (err) { }
    finally {
      this.loading.set(false);
    }
  }
}
