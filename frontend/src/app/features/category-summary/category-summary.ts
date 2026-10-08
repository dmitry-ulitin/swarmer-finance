import { ChangeDetectionStrategy, Component, computed, inject, resource } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { TuiHint, TuiIcon, TuiLoader } from '@taiga-ui/core';
import { ApiService } from '../../core/api.service';
import { TransactionsState } from '../../core/transactions.state';
import { MoneyPipe } from '../../core/money.pipe';
import { CategorySummaryItem } from '../../models/transaction';

interface SummaryRow extends CategorySummaryItem {
  /** Width of the bar, as a share of the block total. */
  share: number;
  /** The unconverted amounts, when they say more than the total does. */
  hint: string | null;
}

interface SummaryBlock {
  type: 'income' | 'expense';
  title: string;
  /** Null when some category could not be converted. */
  total: number | null;
  rows: SummaryRow[];
}

/** Income and expenses per top-level category, for the current account and date filters. */
@Component({
  selector: 'app-category-summary',
  imports: [MoneyPipe, TuiHint, TuiIcon, TuiLoader],
  providers: [MoneyPipe],
  templateUrl: './category-summary.html',
  styleUrl: './category-summary.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class CategorySummaryPanel {
  private readonly api = inject(ApiService);
  protected readonly transactions = inject(TransactionsState);
  private readonly money = inject(MoneyPipe);

  private readonly summary = resource({
    params: () => ({
      accounts: this.transactions.selectedAccountIds(),
      range: this.transactions.dateRange(),
      revision: this.transactions.revision(),
    }),
    loader: async ({ params }) => {
      const r = await firstValueFrom(this.api.getCategorySummary({
        accounts: params.accounts,
        from: params.range?.from,
        to: params.range?.to,
      }));
      return r.data;
    },
  });

  protected readonly loading = this.summary.isLoading;
  protected readonly selected = computed(() => new Set(this.transactions.selectedCategoryIds()));
  protected readonly currency = computed(() => this.summary.value()?.currency ?? '');
  protected readonly scale = computed(() => this.summary.value()?.scale ?? 2);

  protected readonly blocks = computed<SummaryBlock[]>(() => {
    const summary = this.summary.value();
    if (!summary) return [];
    const blocks: SummaryBlock[] = [
      this.block('income', 'Income', summary.income, summary.currency),
      this.block('expense', 'Expenses', summary.expense, summary.currency),
    ];
    return blocks.filter(b => b.rows.length > 0);
  });

  private block(type: SummaryBlock['type'], title: string, items: CategorySummaryItem[], currency: string): SummaryBlock {
    const total = items.some(i => i.total === null) ? null : items.reduce((sum, i) => sum + i.total!, 0);
    const rows = items.map(i => ({
      ...i,
      share: total && i.total !== null ? Math.round((i.total / total) * 100) : 0,
      hint: this.hint(i, currency),
    }));
    return { type, title, total, rows };
  }

  private hint(item: CategorySummaryItem, currency: string): string | null {
    if (item.amounts.length === 1 && item.amounts[0].currency === currency) return null;
    return item.amounts.map(a => this.money.transform(a.amount, a.currency, a.scale)).join(' + ');
  }
}
