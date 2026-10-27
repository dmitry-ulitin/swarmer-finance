import { ChangeDetectionStrategy, Component, computed, inject, resource } from '@angular/core';
import { firstValueFrom } from 'rxjs';
import { TuiHint, TuiIcon, TuiLoader } from '@taiga-ui/core';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { TransactionsState } from '../../core/transactions.state';
import { MoneyPipe } from '../../core/money.pipe';
import { NotificationService } from '../../core/notification.service';
import { amountsHint } from '../../core/money-hint';
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
  private readonly auth = inject(AuthService);
  protected readonly transactions = inject(TransactionsState);
  private readonly money = inject(MoneyPipe);
  private readonly notifications = inject(NotificationService);

  private readonly summary = resource({
    // Logout resets the filters before this panel is gone; undefined keeps it from refetching without a token.
    params: () => this.auth.isAuthenticated() ? {
      accounts: this.transactions.selectedAccountIds(),
      range: this.transactions.dateRange(),
      revision: this.transactions.revision(),
    } : undefined,
    loader: async ({ params }) => {
      try {
        const r = await firstValueFrom(this.api.getCategorySummary({
          accounts: params.accounts,
          from: params.range?.from,
          to: params.range?.to,
        }));
        return r.data;
      } catch (e) {
        this.notifications.showError(e, 'Failed to load the summary');
        throw e;
      }
    },
  });
  // value() throws while the resource is in its error state.
  private readonly value = computed(() => (this.summary.hasValue() ? this.summary.value() : null));

  protected readonly loading = this.summary.isLoading;
  protected readonly selected = computed(() => new Set(this.transactions.selectedCategoryIds()));
  protected readonly currency = computed(() => this.value()?.currency ?? '');
  protected readonly scale = computed(() => this.value()?.scale ?? 2);

  protected readonly blocks = computed<SummaryBlock[]>(() => {
    const summary = this.value();
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
      hint: amountsHint(this.money, i.amounts, currency),
    }));
    return { type, title, total, rows };
  }
}
