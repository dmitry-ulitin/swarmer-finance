import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { TuiDay, TuiDayRange } from '@taiga-ui/cdk/date-time';
import { TuiButton, TuiButtonX, TuiDropdown, TuiIcon } from '@taiga-ui/core';
import { TuiChip } from '@taiga-ui/kit';
import { TransactionsState } from '../../../core/transactions.state';
import { periodKind, rangeLabel, shiftPeriod } from './date-range';
import { DateRangeMenu } from './date-range-menu';

@Component({
  selector: 'app-date-range-filter',
  imports: [DateRangeMenu, TuiButton, TuiButtonX, TuiChip, TuiDropdown, TuiIcon],
  templateUrl: './date-range-filter.html',
  styleUrl: './date-range-filter.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DateRangeFilter {
  private readonly transactions = inject(TransactionsState);
  protected readonly open = signal(false);
  protected readonly range = computed(() => {
    const range = this.transactions.dateRange();
    return range && new TuiDayRange(TuiDay.jsonParse(range.from), TuiDay.jsonParse(range.to));
  });
  protected readonly steppable = computed(() => {
    const range = this.range();
    return !!range && periodKind(range) !== null;
  });
  protected readonly label = computed(() => {
    const range = this.range();
    return range ? rangeLabel(range) : 'Any time';
  });

  protected select(range: TuiDayRange): void {
    this.open.set(false);
    this.apply(range);
  }

  protected shift(step: number): void {
    this.apply(shiftPeriod(this.range()!, step));
  }

  protected clear(): void {
    this.transactions.setDateRange(null);
  }

  private apply({ from, to }: TuiDayRange): void {
    this.transactions.setDateRange({ from: from.toJSON(), to: to.toJSON() });
  }
}
