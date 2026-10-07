import { ChangeDetectionStrategy, Component, computed, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { TuiButtonX, TuiInput } from '@taiga-ui/core';
import { TuiAutoColorPipe, TuiChip } from '@taiga-ui/kit';
import { debounceTime, distinctUntilChanged, map } from 'rxjs';
import { TransactionsState } from '../../core/transactions.state';
import { AccountsState, selectedAccountChips } from '../../core/accounts.state';
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
  protected readonly accountChips = computed(() =>
    selectedAccountChips(this.accounts.groupedAccounts(), new Set(this.transactions.selectedAccountIds()))
  );
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
