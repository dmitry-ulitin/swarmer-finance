import { ChangeDetectionStrategy, Component, inject, resource, signal } from '@angular/core';
import { DatePipe, DecimalPipe } from '@angular/common';
import { TuiButton, TuiLoader } from '@taiga-ui/core';
import type { TuiDialogContext } from '@taiga-ui/core';
import { POLYMORPHEUS_CONTEXT } from '@taiga-ui/polymorpheus';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../../core/api.service';
import { NotificationService } from '../../../core/notification.service';
import { TransactionsState } from '../../../core/transactions.state';

/**
 * Downloads the transaction list's current filter as a CSV statement. Shows
 * what the file will hold first, so a whole history is never a surprise.
 */
@Component({
  selector: 'app-export-statement',
  imports: [DatePipe, DecimalPipe, TuiButton, TuiLoader],
  template: `
    @if (preview.isLoading()) {
      <tui-loader />
    } @else if (preview.value(); as p) {
      @if (p.rows === 0) {
        <p class="summary">No transactions match the current filters.</p>
      } @else {
        <p class="summary">
          {{ p.rows | number }} {{ p.rows === 1 ? 'row' : 'rows' }}
          · {{ p.accounts }} {{ p.accounts === 1 ? 'account' : 'accounts' }}
          · {{ p.from | date: 'dd MMM yyyy' }} – {{ p.to | date: 'dd MMM yyyy' }}
        </p>
        <p class="hint">A transfer between two exported accounts is one row per account.</p>
      }
    } @else if (preview.error()) {
      <p class="summary" role="alert">Could not count the transactions to export.</p>
    }
    <div class="actions">
      <button tuiButton size="s" type="button" appearance="outline" (click)="cancel()">Cancel</button>
      <button tuiButton size="s" type="button" [disabled]="!preview.value()?.rows || downloading()" (click)="download()">
        {{ downloading() ? 'Downloading...' : 'Download CSV' }}
      </button>
    </div>
  `,
  styles: `
    .summary { margin: 0 0 0.5rem; }
    .hint { margin: 0; color: var(--tui-text-secondary); font: var(--tui-font-text-s); }
    .actions { display: flex; justify-content: flex-end; gap: 0.5rem; margin-top: 1.5rem; }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ExportStatement {
  private readonly context = inject<TuiDialogContext<boolean, void>>(POLYMORPHEUS_CONTEXT);
  private readonly api = inject(ApiService);
  private readonly notifications = inject(NotificationService);
  private readonly filters = inject(TransactionsState).filters();

  readonly downloading = signal(false);
  readonly preview = resource({
    loader: async () => (await firstValueFrom(this.api.previewExport(this.filters))).data,
  });

  cancel(): void {
    this.context.completeWith(false);
  }

  async download(): Promise<void> {
    try {
      this.downloading.set(true);
      const blob = await firstValueFrom(this.api.exportTransactions(this.filters));
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `statement-${new Date().toISOString().slice(0, 10)}.csv`;
      link.click();
      URL.revokeObjectURL(url);
      this.context.completeWith(true);
    } catch (e) {
      this.notifications.showError(e, 'Failed to export transactions');
    } finally {
      this.downloading.set(false);
    }
  }
}
