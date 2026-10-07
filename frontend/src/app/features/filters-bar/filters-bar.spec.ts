import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { FiltersBar } from './filters-bar';
import { TransactionsState } from '../../core/transactions.state';

describe('FiltersBar', () => {
  let setDetails: ReturnType<typeof vi.fn>;
  let input: HTMLInputElement;

  beforeEach(() => {
    vi.useFakeTimers();
    setDetails = vi.fn();
    TestBed.configureTestingModule({
      providers: [{ provide: TransactionsState, useValue: { setDetails } }],
    });
    const fixture = TestBed.createComponent(FiltersBar);
    fixture.detectChanges();
    input = fixture.nativeElement.querySelector('input');
  });

  afterEach(() => vi.useRealTimers());

  function type(value: string): void {
    input.value = value;
    input.dispatchEvent(new Event('input'));
  }

  it('searches by the trimmed text after a pause', () => {
    type('  coffee ');
    vi.advanceTimersByTime(299);
    expect(setDetails).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(setDetails).toHaveBeenCalledExactlyOnceWith('coffee');
  });

  it('searches only for the last text typed during the pause', () => {
    type('cof');
    vi.advanceTimersByTime(100);
    type('coffee');
    vi.advanceTimersByTime(300);
    expect(setDetails).toHaveBeenCalledExactlyOnceWith('coffee');
  });

  it('clears the search when the field is emptied', () => {
    type('coffee');
    vi.advanceTimersByTime(300);
    type('   ');
    vi.advanceTimersByTime(300);
    expect(setDetails).toHaveBeenLastCalledWith(undefined);
  });
});
