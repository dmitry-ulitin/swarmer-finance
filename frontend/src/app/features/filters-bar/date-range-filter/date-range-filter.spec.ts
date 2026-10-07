import { describe, it, expect, beforeEach, vi } from 'vitest';
import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { DateRangeFilter } from './date-range-filter';
import { DateRange, TransactionsState } from '../../../core/transactions.state';

describe('DateRangeFilter', () => {
  let setDateRange: ReturnType<typeof vi.fn>;
  let dateRange: ReturnType<typeof signal<DateRange | null>>;
  let fixture: ComponentFixture<DateRangeFilter>;

  beforeEach(() => {
    setDateRange = vi.fn();
    dateRange = signal<DateRange | null>(null);
    TestBed.configureTestingModule({
      providers: [{ provide: TransactionsState, useValue: { dateRange, setDateRange } }],
    });
    fixture = TestBed.createComponent(DateRangeFilter);
  });

  function button(label: string): HTMLButtonElement | null {
    fixture.detectChanges();
    return fixture.nativeElement.querySelector(`button[aria-label="${label}"]`);
  }

  function text(): string {
    fixture.detectChanges();
    return fixture.nativeElement.querySelector('.label').textContent.trim();
  }

  it('shows "Any time" without arrows or a clear button when no range is set', () => {
    expect(text()).toBe('Any time');
    expect(button('Previous period')).toBeNull();
    expect(button('Next period')).toBeNull();
    expect(button('Clear dates')).toBeNull();
  });

  it('steps through months', () => {
    dateRange.set({ from: '2026-12-01', to: '2026-12-31' });
    expect(text()).toBe('Dec 2026');
    button('Next period')!.click();
    expect(setDateRange).toHaveBeenLastCalledWith({ from: '2027-01-01', to: '2027-01-31' });
    button('Previous period')!.click();
    expect(setDateRange).toHaveBeenLastCalledWith({ from: '2026-11-01', to: '2026-11-30' });
  });

  it('steps through years', () => {
    dateRange.set({ from: '2026-01-01', to: '2026-12-31' });
    expect(text()).toBe('2026');
    button('Previous period')!.click();
    expect(setDateRange).toHaveBeenLastCalledWith({ from: '2025-01-01', to: '2025-12-31' });
  });

  it('shows no arrows for an arbitrary range', () => {
    dateRange.set({ from: '2026-09-01', to: '2026-10-15' });
    expect(text()).toBe('1 Sep – 15 Oct 2026');
    expect(button('Previous period')).toBeNull();
    expect(button('Next period')).toBeNull();
  });

  it('clears the range with its X button', () => {
    dateRange.set({ from: '2026-09-01', to: '2026-10-15' });
    button('Clear dates')!.click();
    expect(setDateRange).toHaveBeenCalledExactlyOnceWith(null);
  });
});
