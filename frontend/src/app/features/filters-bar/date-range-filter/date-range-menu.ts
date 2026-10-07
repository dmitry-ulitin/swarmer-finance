import { ChangeDetectionStrategy, Component, computed, input, output, signal } from '@angular/core';
import { TuiDay, TuiDayRange, TuiMonth } from '@taiga-ui/cdk/date-time';
import { TuiButton, TuiDataList, TuiIcon } from '@taiga-ui/core';
import { TuiCalendarRange } from '@taiga-ui/kit';
import { datePresets, sameRange } from './date-range';

/** Dropdown content of DateRangeFilter: preset list, or a range calendar for "Other date…". */
@Component({
  selector: 'app-date-range-menu',
  imports: [TuiButton, TuiCalendarRange, TuiDataList, TuiIcon],
  templateUrl: './date-range-menu.html',
  styleUrl: './date-range-menu.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class DateRangeMenu {
  readonly range = input<TuiDayRange | null>(null);
  readonly selected = output<TuiDayRange>();

  protected readonly presets = datePresets(TuiDay.currentLocal());
  protected readonly custom = signal(false);
  /** Without a range the calendar shows last and this month: a filter looks back, not ahead. */
  protected readonly lastMonth = TuiMonth.currentLocal().append({ month: -1 });
  protected readonly activePreset = computed(() => {
    const range = this.range();
    return this.presets.find(p => sameRange(p.range, range)) ?? null;
  });

  /** `valueChange` is typed nullable, but without `items` the calendar only emits complete ranges. */
  protected select(range: TuiDayRange | null): void {
    if (range) this.selected.emit(range);
  }
}
