import { describe, it, expect, beforeEach, vi } from 'vitest';
import { signal } from '@angular/core';
import { ComponentFixture, TestBed } from '@angular/core/testing';
import { of, throwError } from 'rxjs';
import { CategorySummaryPanel } from './category-summary';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { DateRange, TransactionsState } from '../../core/transactions.state';
import { NotificationService } from '../../core/notification.service';
import { CategorySummary, CategorySummaryItem, TransactionFilters } from '../../models/transaction';

function item(name: string, total: number | null): CategorySummaryItem {
  return { category_id: name.length, name, color: '#123456', icon: 'tag', total, amounts: [{ currency: 'EUR', scale: 2, amount: total ?? 0 }] };
}

const NO_TRANSFERS: CategorySummary['transfers'] = {
  net: 0,
  in: { total: 0, amounts: [] },
  out: { total: 0, amounts: [] },
};

function side(total: number | null, currency = 'EUR', amount = total ?? 0): CategorySummary['transfers']['in'] {
  return { total, amounts: [{ currency, scale: 2, amount }] };
}

describe('CategorySummaryPanel', () => {
  let getCategorySummary: ReturnType<typeof vi.fn>;
  let selectedAccountIds: ReturnType<typeof signal<number[]>>;
  let dateRange: ReturnType<typeof signal<DateRange | null>>;
  let revision: ReturnType<typeof signal<number>>;
  let selectedCategoryIds: ReturnType<typeof signal<number[]>>;
  let selectCategory: ReturnType<typeof vi.fn>;
  let toggleCategory: ReturnType<typeof vi.fn>;
  let selectedType: ReturnType<typeof signal<TransactionFilters['type']>>;
  let selectType: ReturnType<typeof vi.fn>;
  let showError: ReturnType<typeof vi.fn>;
  let isAuthenticated: ReturnType<typeof signal<boolean>>;
  let fixture: ComponentFixture<CategorySummaryPanel>;

  function respond(summary: Partial<CategorySummary>): void {
    getCategorySummary.mockReturnValue(of({
      data: { currency: 'EUR', scale: 2, income: [], expense: [], transfers: NO_TRANSFERS, ...summary }, error: null,
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
    selectedType = signal<TransactionFilters['type']>(undefined);
    selectType = vi.fn();
    showError = vi.fn();
    isAuthenticated = signal(true);
    TestBed.configureTestingModule({
      providers: [
        { provide: ApiService, useValue: { getCategorySummary } },
        { provide: NotificationService, useValue: { showError } },
        { provide: AuthService, useValue: { isAuthenticated } },
        { provide: TransactionsState, useValue: { selectedAccountIds, dateRange, revision, selectedCategoryIds, selectCategory, toggleCategory, selectedType, selectType } },
      ],
    });
    fixture = TestBed.createComponent(CategorySummaryPanel);
  });

  it('requests the summary for the account and date filters', async () => {
    selectedAccountIds.set([3]);
    dateRange.set({ from: '2026-03-01', to: '2026-03-31' });
    await render();
    expect(getCategorySummary).toHaveBeenLastCalledWith({ accounts: [3], from: '2026-03-01', to: '2026-03-31' });
  });

  it('does not refetch when logout resets the filters', async () => {
    await render();
    getCategorySummary.mockClear();

    isAuthenticated.set(false);
    revision.set(1);
    selectedAccountIds.set([]);
    await render();
    expect(getCategorySummary).not.toHaveBeenCalled();
    expect(showError).not.toHaveBeenCalled();
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

  it('renders without blocks and reports the error when the load fails', async () => {
    getCategorySummary.mockReturnValue(throwError(() => new Error('down')));
    const el = await render();
    expect(el.querySelector('.block')).toBeNull();
    expect(showError).toHaveBeenCalledWith(expect.any(Error), 'Failed to load the summary');
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

  it('filters by income or expense on a block header click', async () => {
    respond({ income: [item('Salary', 100)], expense: [item('Food', 75)] });
    const el = await render();
    const headers = el.querySelectorAll<HTMLButtonElement>('.block-header');

    headers[0].click();
    headers[1].click();

    expect(selectType.mock.calls).toEqual([['income'], ['expense']]);
  });

  it('marks the selected type', async () => {
    respond({ income: [item('Salary', 100)], expense: [item('Food', 75)] });
    selectedType.set('expense');
    const el = await render();
    const headers = el.querySelectorAll('.block-header');

    expect(headers[1].classList).toContain('selected');
    expect(headers[1].getAttribute('aria-pressed')).toBe('true');
    expect(headers[0].getAttribute('aria-pressed')).toBe('false');
  });

  it('filters by transfers', async () => {
    respond({ expense: [item('Food', 75)] });
    const el = await render();
    const transfers = el.querySelector<HTMLButtonElement>('.transfers')!;

    transfers.click();

    expect(selectType).toHaveBeenCalledExactlyOnceWith('transfer');
  });

  it('hides transfers when there is no income, expenses or transfers', async () => {
    const el = await render();
    expect(el.querySelector('.transfers')).toBeNull();
  });

  it('marks transfers when selected', async () => {
    respond({ expense: [item('Food', 75)] });
    selectedType.set('transfer');
    const el = await render();
    const transfers = el.querySelector('.transfers')!;

    expect(transfers.classList).toContain('selected');
    expect(transfers.getAttribute('aria-pressed')).toBe('true');
  });

  describe('transfer amounts', () => {
    const transferRow = (el: HTMLElement, type: string) =>
      el.querySelector<HTMLButtonElement>(`.row[data-transfer="${type}"]`)!;

    it('shows the net and both directions, bars relative to the larger', async () => {
      respond({ transfers: { net: 50, in: side(100), out: side(50) } });
      const el = await render();

      expect(el.querySelector('.transfers .block-total')!.textContent).toContain('50');
      const incoming = transferRow(el, 'transfer_in');
      expect(incoming.querySelector('.name')!.textContent).toContain('Incoming');
      expect(incoming.querySelector('.amount')!.textContent).toContain('100');
      expect((incoming.querySelector('.bar-fill') as HTMLElement).style.width).toBe('100%');
      const outgoing = transferRow(el, 'transfer_out');
      expect(outgoing.querySelector('.name')!.textContent).toContain('Outgoing');
      expect(outgoing.querySelector('.amount')!.textContent).toContain('50');
      expect((outgoing.querySelector('.bar-fill') as HTMLElement).style.width).toBe('50%');
    });

    it('filters by a direction', async () => {
      respond({ transfers: { net: 50, in: side(100), out: side(50) } });
      const el = await render();

      transferRow(el, 'transfer_in').click();
      expect(selectType).toHaveBeenLastCalledWith('transfer_in');
      transferRow(el, 'transfer_out').click();
      expect(selectType).toHaveBeenLastCalledWith('transfer_out');
    });

    it('marks the selected direction only', async () => {
      respond({ transfers: { net: 50, in: side(100), out: side(50) } });
      selectedType.set('transfer_out');
      const el = await render();

      expect(transferRow(el, 'transfer_out').classList).toContain('selected');
      expect(transferRow(el, 'transfer_out').getAttribute('aria-pressed')).toBe('true');
      expect(transferRow(el, 'transfer_in').classList).not.toContain('selected');
      expect(el.querySelector('.transfers')!.classList).not.toContain('selected');
    });

    it('shows the block when transfers are all there is', async () => {
      respond({ transfers: { net: 10, in: side(10), out: { total: 0, amounts: [] } } });
      const el = await render();

      expect(el.querySelector('.transfers')).not.toBeNull();
      expect(transferRow(el, 'transfer_out').querySelector('.amount')!.textContent).toContain('0');
      expect(el.querySelector('.empty')).toBeNull();
    });

    it('shows the button but no directions when there are no transfers', async () => {
      respond({ expense: [item('Food', 75)] });
      const el = await render();

      expect(el.querySelector('.transfers')).not.toBeNull();
      expect(el.querySelector('.transfers .block-total')).toBeNull();
      expect(transferRow(el, 'transfer_in')).toBeNull();
    });

    it('shows a dash when a rate is missing', async () => {
      respond({ transfers: { net: null, in: side(null, 'ZZQ', 5), out: side(10) } });
      const el = await render();

      expect(el.querySelector('.transfers .block-total')).toBeNull();
      expect(transferRow(el, 'transfer_in').querySelector('.amount')!.textContent).toContain('—');
    });

    it('shows a zero net when the directions balance', async () => {
      respond({ transfers: { net: 0, in: side(10), out: side(10) } });
      const el = await render();

      expect(el.querySelector('.transfers .block-total')!.textContent).toContain('0');
    });
  });
});
