import { describe, it, expect } from 'vitest';
import { TuiDay, TuiDayRange } from '@taiga-ui/cdk/date-time';
import { datePresets, periodKind, rangeLabel, sameRange, shiftPeriod } from './date-range';

const range = (from: string, to: string) => new TuiDayRange(TuiDay.jsonParse(from), TuiDay.jsonParse(to));
const json = (r: TuiDayRange) => [r.from.toJSON(), r.to.toJSON()];

describe('periodKind', () => {
  it('recognises a whole calendar month', () => {
    expect(periodKind(range('2026-09-01', '2026-09-30'))).toBe('month');
    expect(periodKind(range('2024-02-01', '2024-02-29'))).toBe('month');
  });

  it('recognises a whole calendar year', () => {
    expect(periodKind(range('2026-01-01', '2026-12-31'))).toBe('year');
  });

  it('returns null for any other range', () => {
    expect(periodKind(range('2026-09-01', '2026-09-29'))).toBeNull();
    expect(periodKind(range('2026-09-02', '2026-09-30'))).toBeNull();
    expect(periodKind(range('2026-09-01', '2026-10-31'))).toBeNull();
    expect(periodKind(range('2025-01-01', '2026-12-31'))).toBeNull();
  });
});

describe('shiftPeriod', () => {
  it('moves a month by one, keeping it whole', () => {
    expect(json(shiftPeriod(range('2026-01-01', '2026-01-31'), 1))).toEqual(['2026-02-01', '2026-02-28']);
    expect(json(shiftPeriod(range('2026-03-01', '2026-03-31'), -1))).toEqual(['2026-02-01', '2026-02-28']);
  });

  it('crosses the year boundary', () => {
    expect(json(shiftPeriod(range('2026-12-01', '2026-12-31'), 1))).toEqual(['2027-01-01', '2027-01-31']);
    expect(json(shiftPeriod(range('2026-01-01', '2026-01-31'), -1))).toEqual(['2025-12-01', '2025-12-31']);
  });

  it('moves a year by one', () => {
    expect(json(shiftPeriod(range('2026-01-01', '2026-12-31'), -1))).toEqual(['2025-01-01', '2025-12-31']);
  });
});

describe('rangeLabel', () => {
  it('names a month and a year', () => {
    expect(rangeLabel(range('2026-09-01', '2026-09-30'))).toBe('Sep 2026');
    expect(rangeLabel(range('2026-01-01', '2026-12-31'))).toBe('2026');
  });

  it('shows the year once for a range within one year', () => {
    expect(rangeLabel(range('2026-09-01', '2026-10-15'))).toBe('1 Sep – 15 Oct 2026');
  });

  it('shows both years for a range across years', () => {
    expect(rangeLabel(range('2025-12-15', '2026-01-10'))).toBe('15 Dec 2025 – 10 Jan 2026');
  });

  it('shows a single day once', () => {
    expect(rangeLabel(range('2026-09-05', '2026-09-05'))).toBe('5 Sep 2026');
  });
});

describe('datePresets', () => {
  const presets = (today: string) =>
    datePresets(TuiDay.jsonParse(today)).map(p => [p.label, ...json(p.range)]);

  it('builds rolling month and year up to today, then the current month and year', () => {
    expect(presets('2026-10-07')).toEqual([
      ['Last month', '2026-09-08', '2026-10-07'],
      ['Last year', '2025-10-08', '2026-10-07'],
      ['Oct 2026', '2026-10-01', '2026-10-31'],
      ['2026', '2026-01-01', '2026-12-31'],
    ]);
  });

  it('starts the rolling month after the clamped day a month ago at a month end', () => {
    expect(presets('2026-03-31')[0]).toEqual(['Last month', '2026-03-01', '2026-03-31']);
  });
});

describe('sameRange', () => {
  it('compares both ends', () => {
    expect(sameRange(range('2026-09-01', '2026-09-30'), range('2026-09-01', '2026-09-30'))).toBe(true);
    expect(sameRange(range('2026-09-01', '2026-09-30'), range('2026-09-01', '2026-09-29'))).toBe(false);
    expect(sameRange(range('2026-09-01', '2026-09-30'), null)).toBe(false);
  });
});
