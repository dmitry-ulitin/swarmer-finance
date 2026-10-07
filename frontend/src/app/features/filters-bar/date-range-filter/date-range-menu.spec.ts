import { describe, it, expect, beforeEach } from 'vitest';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { TuiDay, TuiDayRange } from '@taiga-ui/cdk/date-time';
import { DateRangeMenu } from './date-range-menu';

const range = (from: string, to: string) => new TuiDayRange(TuiDay.jsonParse(from), TuiDay.jsonParse(to));

describe('DateRangeMenu', () => {
  let fixture: ComponentFixture<DateRangeMenu>;
  let selected: TuiDayRange[];

  beforeEach(() => {
    fixture = TestBed.createComponent(DateRangeMenu);
    selected = [];
    fixture.componentInstance.selected.subscribe(r => selected.push(r));
  });

  function options(): HTMLButtonElement[] {
    fixture.detectChanges();
    return Array.from(fixture.nativeElement.querySelectorAll('[tuiOption]'));
  }

  function option(label: string): HTMLButtonElement {
    return options().find(o => o.textContent!.trim() === label)!;
  }

  function checked(): string[] {
    return options().filter(o => o.querySelector('tui-icon')).map(o => o.textContent!.trim());
  }

  it('lists the presets and "Other date…"', () => {
    const today = TuiDay.currentLocal();
    expect(options().map(o => o.textContent!.trim())).toEqual([
      'Last month', 'Last year', expect.stringMatching(/^\w{3} \d{4}$/), String(today.year), 'Other date…',
    ]);
  });

  it('emits the range of a picked preset', () => {
    option(String(TuiDay.currentLocal().year)).click();
    const year = TuiDay.currentLocal().year;
    expect(selected.map(r => [r.from.toJSON(), r.to.toJSON()])).toEqual([[`${year}-01-01`, `${year}-12-31`]]);
  });

  it('checks the preset equal to the current range', () => {
    const year = TuiDay.currentLocal().year;
    fixture.componentRef.setInput('range', range(`${year}-01-01`, `${year}-12-31`));
    expect(checked()).toEqual([String(year)]);
  });

  it('checks "Other date…" for a range matching no preset', () => {
    fixture.componentRef.setInput('range', range('2020-02-03', '2020-02-10'));
    expect(checked()).toEqual(['Other date…']);
  });

  it('checks nothing without a range', () => {
    expect(checked()).toEqual([]);
  });

  it('opens the range calendar for "Other date…" and goes back to the list', () => {
    option('Other date…').click();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('tui-calendar-range')).not.toBeNull();
    expect(options()).toHaveLength(0);
    (fixture.nativeElement.querySelector('button[aria-label="Back"]') as HTMLButtonElement).click();
    expect(options()).toHaveLength(5);
  });
});
