import { ChangeDetectionStrategy, Component, computed, inject, resource } from '@angular/core';
import { DecimalPipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { firstValueFrom } from 'rxjs';
import { TuiAxes } from '@taiga-ui/addon-charts/components/axes';
import { TuiBarChart } from '@taiga-ui/addon-charts/components/bar-chart';
import { TuiChartHint } from '@taiga-ui/addon-charts/components/chart-hint';
import { TuiCheckbox, TuiHint, TuiLoader } from '@taiga-ui/core';
import { ApiService } from '../../core/api.service';
import { AccountsState } from '../../core/accounts.state';
import { AuthService } from '../../core/auth.service';
import { NotificationService } from '../../core/notification.service';
import { MoneyPipe } from '../../core/money.pipe';
import { PageReload } from '../../core/page-reload';
import { currencyScale } from '../../core/currency-scale';
import { TYPE_LABELS, type AccountType } from '../../models/account';
import type { NetWorth } from '../../models/net-worth';

const ACCOUNT_TYPES: AccountType[] = ['cash', 'bank', 'crypto', 'investment', 'property', 'deposit', 'debt'];
/** Roughly how many month labels fit under the chart. */
const MAX_LABELS = 12;

@Component({
  selector: 'app-net-worth',
  imports: [FormsModule, DecimalPipe, MoneyPipe, TuiAxes, TuiBarChart, TuiChartHint, TuiCheckbox, TuiHint, TuiLoader],
  templateUrl: './net-worth.html',
  styleUrl: './net-worth.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NetWorthPage {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly accounts = inject(AccountsState);
  private readonly notifications = inject(NotificationService);

  // Follows account changes (edits, valuations, imports) made while the page is open.
  private readonly resource = resource<NetWorth | null, { authenticated: boolean; version: number }>({
    params: () => ({ authenticated: this.auth.isAuthenticated(), version: this.accounts.version() }),
    loader: async ({ params }) => {
      if (!params.authenticated) return null;
      try {
        return (await firstValueFrom(this.api.getNetWorth())).data;
      } catch (e) {
        this.notifications.showError(e, 'Failed to load net worth');
        throw e;
      }
    },
  });

  constructor() {
    inject(PageReload).register('Reload net worth', () => this.resource.reload());
  }

  // value() throws while the resource is in its error state.
  readonly data = computed(() => (this.resource.hasValue() ? this.resource.value() : null));
  readonly loading = this.resource.isLoading;

  /** Decimals of the user's currency, for every amount converted into it. */
  readonly scale = computed(() => this.auth.user()?.currency_scale ?? 2);
  readonly accountScale = currencyScale;

  readonly typeLabel = (type: AccountType): string => TYPE_LABELS[type];

  /** One series per account type that has a non-zero value at some point. */
  readonly series = computed(() => {
    const history = this.data()?.history ?? [];
    return ACCOUNT_TYPES
      .map(type => ({ type, values: history.map(p => p.byType[type] ?? 0) }))
      .filter(s => s.values.some(v => v !== 0));
  });
  readonly chartValues = computed(() => this.series().map(s => s.values));
  readonly chartMax = computed(() => {
    const top = Math.max(0, ...(this.data()?.history ?? []).map(p => p.total));
    const step = 10 ** Math.max(0, Math.floor(Math.log10(top || 1)) - 1);
    return Math.max(step, Math.ceil(top / step) * step);
  });
  readonly labelsX = computed(() => {
    const history = this.data()?.history ?? [];
    const every = Math.ceil(history.length / MAX_LABELS) || 1;
    return history.map((p, i) => (i % every === 0 ? this.monthLabel(p.date) : ''));
  });
  readonly labelsY = computed(() => ['0', new Intl.NumberFormat(undefined, { notation: 'compact' }).format(this.chartMax())]);

  colorOf(type: AccountType): string {
    const index = this.series().findIndex(s => s.type === type);
    return `var(--tui-chart-categorical-${String(Math.max(index, 0)).padStart(2, '0')})`;
  }

  share(value: number): number {
    const total = this.data()?.total ?? 0;
    return total ? (value / total) * 100 : 0;
  }

  private monthLabel(date: string): string {
    return new Date(`${date}T00:00:00Z`).toLocaleDateString(undefined, { month: 'short', year: '2-digit', timeZone: 'UTC' });
  }

  point(index: number) {
    return this.data()?.history[index];
  }

  async toggle(id: number, include: boolean): Promise<void> {
    try {
      // Reloads the accounts, and with them this page.
      await firstValueFrom(this.accounts.setInNetWorth(id, include));
    } catch (e) {
      this.notifications.showError(e, 'Failed to update net worth');
      // Puts the checkbox back.
      this.resource.reload();
    }
  }
}
