import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { TuiDay } from '@taiga-ui/cdk/date-time';
import { POLYMORPHEUS_CONTEXT } from '@taiga-ui/polymorpheus';
import { BankLoad } from './bank-load';

function render() {
  const completeWith = vi.fn();
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: POLYMORPHEUS_CONTEXT, useValue: { completeWith } },
    ],
  });
  const fixture = TestBed.createComponent(BankLoad);
  fixture.detectChanges();
  return { cmp: fixture.componentInstance, completeWith };
}

describe('BankLoad', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('defaults to 90 days ago and completes with an ISO date', () => {
    const { cmp, completeWith } = render();
    const expected = TuiDay.currentLocal().append({ day: -90 }).toJSON();
    cmp.submit();
    expect(completeWith).toHaveBeenCalledWith(expected);
  });

  it('completes with null on cancel', () => {
    const { cmp, completeWith } = render();
    cmp.cancel();
    expect(completeWith).toHaveBeenCalledWith(null);
  });
});
