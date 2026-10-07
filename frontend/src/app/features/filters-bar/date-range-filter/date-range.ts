import { TuiDay, TuiDayRange } from '@taiga-ui/cdk/date-time';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export type PeriodKind = 'month' | 'year';

export interface DatePreset {
  label: string;
  range: TuiDayRange;
}

function monthRange(year: number, month: number): TuiDayRange {
  const from = new TuiDay(year, 0, 1).append({ month });
  return new TuiDayRange(from, new TuiDay(from.year, from.month, from.daysCount));
}

function yearRange(year: number): TuiDayRange {
  return new TuiDayRange(new TuiDay(year, 0, 1), new TuiDay(year, 11, 31));
}

/** A range covering exactly one calendar month or year, which can be stepped through. */
export function periodKind({ from, to }: TuiDayRange): PeriodKind | null {
  if (from.day !== 1 || to.year !== from.year) return null;
  if (to.month === from.month && to.day === from.daysCount) return 'month';
  if (from.month === 0 && to.month === 11 && to.day === 31) return 'year';
  return null;
}

/** Moves a month or year range (see `periodKind`) by `step` periods. */
export function shiftPeriod(range: TuiDayRange, step: number): TuiDayRange {
  const { from } = range;
  return periodKind(range) === 'year'
    ? yearRange(from.year + step)
    : monthRange(from.year, from.month + step);
}

export function rangeLabel(range: TuiDayRange): string {
  const { from, to } = range;
  const kind = periodKind(range);
  if (kind === 'month') return `${MONTHS[from.month]} ${from.year}`;
  if (kind === 'year') return String(from.year);
  const day = (d: TuiDay) => `${d.day} ${MONTHS[d.month]}`;
  if (from.daySame(to)) return `${day(to)} ${to.year}`;
  const start = from.year === to.year ? day(from) : `${day(from)} ${from.year}`;
  return `${start} – ${day(to)} ${to.year}`;
}

export function sameRange(a: TuiDayRange, b: TuiDayRange | null): boolean {
  return !!b && a.from.daySame(b.from) && a.to.daySame(b.to);
}

/** Rolling month and year ending today, then the current calendar month and year. */
export function datePresets(today: TuiDay): DatePreset[] {
  const since = (back: { month?: number; year?: number }) =>
    new TuiDayRange(today.append(back).append({ day: 1 }), today);
  const month = monthRange(today.year, today.month);
  const year = yearRange(today.year);
  return [
    { label: 'Last month', range: since({ month: -1 }) },
    { label: 'Last year', range: since({ year: -1 }) },
    { label: rangeLabel(month), range: month },
    { label: rangeLabel(year), range: year },
  ];
}
