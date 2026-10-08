import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { FiltersBar } from './filters-bar';
import { TransactionsState } from '../../core/transactions.state';
import { AccountsState, buildAccountTree } from '../../core/accounts.state';
import { Account } from '../../models/account';
import { CategoriesState } from '../../core/categories.state';
import { Category } from '../../models/category';

function makeAccount(id: number, name: string): Account {
  return {
    id, user_id: 1, name, currency: 'USD', scale: 2, balance: 0, user_balance: 0,
    start_balance: 0, deleted: false, created_at: '', type: 'cash', settings: {},
  };
}

describe('FiltersBar', () => {
  let setDetails: ReturnType<typeof vi.fn>;
  let toggleAccounts: ReturnType<typeof vi.fn>;
  let toggleCategory: ReturnType<typeof vi.fn>;
  let selectedCategoryIds: ReturnType<typeof signal<number[]>>;
  let selectedAccountIds: ReturnType<typeof signal<number[]>>;
  let fixture: ComponentFixture<FiltersBar>;
  let input: HTMLInputElement;

  beforeEach(() => {
    vi.useFakeTimers();
    setDetails = vi.fn();
    toggleAccounts = vi.fn();
    toggleCategory = vi.fn();
    selectedCategoryIds = signal<number[]>([]);
    selectedAccountIds = signal<number[]>([]);
    const groupedAccounts = signal(buildAccountTree([
      makeAccount(1, 'Cash'), makeAccount(2, 'Bank/A'), makeAccount(3, 'Bank/B'),
    ]));
    TestBed.configureTestingModule({
      providers: [
        { provide: TransactionsState, useValue: {
          setDetails, toggleAccounts, selectedAccountIds, dateRange: signal(null), toggleCategory, selectedCategoryIds,
        } },
        { provide: AccountsState, useValue: { groupedAccounts } },
        { provide: CategoriesState, useValue: { categories: signal([{ id: 2, fullName: '', children: [{ id: 7, fullName: 'Food' }] } as Category]) } },
      ],
    });
    fixture = TestBed.createComponent(FiltersBar);
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

  function chips(): HTMLElement[] {
    fixture.detectChanges();
    return Array.from(fixture.nativeElement.querySelectorAll(':scope > [tuiChip]:not([data-kind="category"])'));
  }

  it('shows no account chips without an account filter', () => {
    expect(chips()).toHaveLength(0);
  });

  it('shows a chip per selected account and one for a fully selected group', () => {
    selectedAccountIds.set([1, 2, 3]);
    expect(chips().map(c => c.textContent!.replace('Remove', '').trim())).toEqual(['Bank', 'Cash']);
  });

  it('removes the accounts of a chip with its X button', () => {
    selectedAccountIds.set([2, 3]);
    chips()[0].querySelector('button')!.click();
    expect(toggleAccounts).toHaveBeenCalledExactlyOnceWith([2, 3]);
  });

  function categoryChips(): HTMLElement[] {
    fixture.detectChanges();
    return Array.from(fixture.nativeElement.querySelectorAll('[data-kind="category"]'));
  }

  it('shows a chip per selected category, by its path', () => {
    selectedCategoryIds.set([7, 8]);
    expect(categoryChips().map(c => c.textContent!.replace('Remove', '').trim())).toEqual(['Food', '#8']);
  });

  it('removes a category from the filter with its X button', () => {
    selectedCategoryIds.set([7]);
    categoryChips()[0].querySelector('button')!.click();
    expect(toggleCategory).toHaveBeenCalledExactlyOnceWith(7);
  });
});
