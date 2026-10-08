import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { TuiButtonX, TuiInput } from '@taiga-ui/core';
import { TuiAutoColorPipe, TuiChip } from '@taiga-ui/kit';
import { debounceTime, distinctUntilChanged, map } from 'rxjs';
import { TransactionsState } from '../../core/transactions.state';
import { AccountsState, selectedAccountChips } from '../../core/accounts.state';
import { CategoriesState } from '../../core/categories.state';
import { findCategoryById } from '../../models/category';
import { DateRangeFilter } from './date-range-filter/date-range-filter';

@Component({
  selector: 'app-filters-bar',
  imports: [DateRangeFilter, ReactiveFormsModule, TuiButtonX, TuiChip, TuiAutoColorPipe, TuiInput],
  templateUrl: './filters-bar.html',
  styleUrl: './filters-bar.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FiltersBar {
  protected readonly transactions = inject(TransactionsState);
  private readonly accounts = inject(AccountsState);
  private readonly categories = inject(CategoriesState);
  protected readonly accountChips = computed(() =>
    selectedAccountChips(this.accounts.groupedAccounts(), new Set(this.transactions.selectedAccountIds()))
  );
  protected readonly categoryChips = computed(() => {
    const tree = this.categories.categories();
    return this.transactions.selectedCategoryIds().map(id => ({ id, label: findCategoryById(id, tree)?.fullName ?? `#${id}` }));
  });
  protected readonly details = new FormControl('', { nonNullable: true });

  constructor() {
    this.details.valueChanges.pipe(
      debounceTime(300),
      map(value => value.trim() || undefined),
      distinctUntilChanged(),
      takeUntilDestroyed(),
    ).subscribe(details => this.transactions.setDetails(details));
  }
}
