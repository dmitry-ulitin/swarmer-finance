import { describe, it, expect, beforeEach, vi } from 'vitest';
import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { CategorySummaryPanel } from './category-summary';
import { ApiService } from '../../core/api.service';
import { DateRange, TransactionsState } from '../../core/transactions.state';
import { CategorySummary, CategorySummaryItem } from '../../models/transaction';

function item(name: string, total: number | null): CategorySummaryItem {
  return { category_id: name.length, name, color: '#123456', icon: 'tag', total, amounts: [{ currency: 'EUR', scale: 2, amount: total ?? 0 }] };
}

describe('CategorySummaryPanel', () => {
  let getCategorySummary: ReturnType<typeof vi.fn>;
  let selectedAccountIds: ReturnType<typeof signal<number[]>>;
  let dateRange: ReturnType<typeof signal<DateRange | null>>;
  let revision: ReturnType<typeof signal<number>>;
  let selectedCategoryIds: ReturnType<typeof signal<number[]>>;
  let selectCategory: ReturnType<typeof vi.fn>;
  let toggleCategory: ReturnType<typeof vi.fn>;
  let fixture: ComponentFixture<CategorySummaryPanel>;

  function respond(summary: Partial<CategorySummary>): void {
    getCategorySummary.mockReturnValue(of({
      data: { currency: 'EUR', scale: 2, income: [], expense: [], ...summary }, error: null,
    }));
  }

  async function render(): Promise<HTMLElement> {
    fixture.detectChanges();
    await fixture.whenStable();
    fixture.detectChanges();
    return fixture.nativeElement;
  }

  beforeEach(() => {
    getCategorySummary = vi.fn();
    respond({});
    selectedAccountIds = signal<number[]>([]);
    dateRange = signal<DateRange | null>(null);
    revision = signal(0);
    selectedCategoryIds = signal<number[]>([]);
    selectCategory = vi.fn();
    toggleCategory = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        { provide: ApiService, useValue: { getCategorySummary } },
        { provide: TransactionsState, useValue: { selectedAccountIds, dateRange, revision, selectedCategoryIds, selectCategory, toggleCategory } },
      ],
    });
    fixture = TestBed.createComponent(CategorySummaryPanel);
  });

  it('requests the summary for the account and date filters', async () => {
    selectedAccountIds.set([3]);
    dateRange.set({ from: '2026-03-01', to: '2026-03-31' });
    await render();
    expect(getCategorySummary).toHaveBeenLastCalledWith({ account: [3], from: '2026-03-01', to: '2026-03-31' });
  });

  it('refetches when the filters change or the transactions reload', async () => {
    await render();
    getCategorySummary.mockClear();

    selectedAccountIds.set([1]);
    await render();
    revision.set(1);
    await render();

    expect(getCategorySummary).toHaveBeenCalledTimes(2);
  });

  it('shows each block with its total and rows sized by their share', async () => {
    respond({ expense: [item('Food', 75), item('Transport', 25)] });
    const el = await render();

    const block = el.querySelector('[data-type="expense"]')!;
    expect(block.querySelector('.block-total')!.textContent).toContain('100');
    const rows = block.querySelectorAll('.row');
    expect(rows.length).toBe(2);
    expect(rows[0].querySelector('.name')!.textContent).toContain('Food');
    expect((rows[0].querySelector('.bar-fill') as HTMLElement).style.width).toBe('75%');
    expect(el.querySelector('[data-type="income"]')).toBeNull();
  });

  it('leaves the block total out when a category could not be converted', async () => {
    respond({ expense: [item('Food', 75), item('Crypto', null)] });
    const el = await render();

    expect(el.querySelector('[data-type="expense"] .block-total')).toBeNull();
  });

  it('says so when there is nothing to show', async () => {
    const el = await render();
    expect(el.querySelector('.empty')).not.toBeNull();
  });

  it('filters by a category on click and toggles it on ctrl- or meta-click', async () => {
    respond({ expense: [item('Food', 75)] });
    const el = await render();
    const row = el.querySelector('.row') as HTMLButtonElement;

    row.dispatchEvent(new MouseEvent('click'));
    row.dispatchEvent(new MouseEvent('click', { ctrlKey: true }));
    row.dispatchEvent(new MouseEvent('click', { metaKey: true }));

    expect(selectCategory).toHaveBeenCalledExactlyOnceWith(4);
    expect(toggleCategory).toHaveBeenCalledTimes(2);
    expect(toggleCategory).toHaveBeenCalledWith(4);
  });

  it('marks the selected categories', async () => {
    respond({ expense: [item('Food', 75), item('Transport', 25)] });
    selectedCategoryIds.set([9]);
    const el = await render();
    const rows = el.querySelectorAll('.row');

    expect(rows[1].classList).toContain('selected');
    expect(rows[1].getAttribute('aria-pressed')).toBe('true');
    expect(rows[0].getAttribute('aria-pressed')).toBe('false');
  });
});
