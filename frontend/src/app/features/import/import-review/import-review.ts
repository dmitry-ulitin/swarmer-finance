import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { TuiAppearance, TuiButton, TuiCheckbox, TuiLoader } from '@taiga-ui/core';
import type { TuiDialogContext } from '@taiga-ui/core';
import { TuiBadge } from '@taiga-ui/kit';
import { POLYMORPHEUS_CONTEXT } from '@taiga-ui/polymorpheus';
import { firstValueFrom } from 'rxjs';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../../core/api.service';
import { NotificationService } from '../../../core/notification.service';
import { MoneyPipe } from '../../../core/money.pipe';
import { CategorySelect } from '../../categories/category-select/category-select';
import type { Category } from '../../../models/category';
import { IMPORT_FORMATS } from '../../../models/import';
import type {
  ImportParseResult,
  ImportReconcileResult,
  ImportRow,
  ImportRowStatus,
} from '../../../models/import';

/** A parsed row plus the two things the user controls on this screen. */
export interface ReviewRow extends ImportRow {
  selected: boolean;
  category: Category | null;
}

const STATUS_LABEL: Record<ImportRowStatus, string> = {
  new: 'New',
  duplicate: 'Duplicate',
  possible_duplicate: 'Possible duplicate',
};

@Component({
  selector: 'app-import-review',
  imports: [
    FormsModule,
    TuiCheckbox,
    TuiBadge,
    TuiAppearance,
    TuiButton,
    TuiLoader,
    MoneyPipe,
    CategorySelect,
  ],
  templateUrl: './import-review.html',
  styleUrl: './import-review.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class ImportReview {
  private readonly context =
    inject<TuiDialogContext<ImportReconcileResult | null, ImportParseResult>>(POLYMORPHEUS_CONTEXT);
  private readonly api = inject(ApiService);
  private readonly notifications = inject(NotificationService);

  readonly result = this.context.data;
  readonly account = this.result.account;
  readonly summary = this.result.summary;
  readonly formatName =
    IMPORT_FORMATS.find(f => f.id === this.result.format)?.name ?? this.result.format;

  /**
   * Exact duplicates start unselected — the server has already seen those
   * hashes. Possible duplicates start selected: they are advisory matches
   * against hand-entered transactions, and defaulting them off would quietly
   * drop real rows the user never looked at.
   */
  readonly rows = signal<ReviewRow[]>(
    this.result.rows.map(row => ({
      ...row,
      selected: row.status !== 'duplicate',
      category: null,
    }))
  );

  readonly loading = signal(false);
  readonly selectedCount = computed(() => this.rows().filter(r => r.selected).length);
  readonly allSelected = computed(
    () => this.rows().length > 0 && this.selectedCount() === this.rows().length
  );

  readonly statusLabel = (status: ImportRowStatus): string => STATUS_LABEL[status];

  readonly statusAppearance = (status: ImportRowStatus): string =>
    status === 'duplicate' ? 'negative' : status === 'possible_duplicate' ? 'warning' : 'success';

  /** 1 = Income, 2 = Expenses, following the row's own sign. */
  readonly rootIdFor = (row: ReviewRow): number => (row.amount < 0 ? 2 : 1);

  toggle(index: number, selected: boolean): void {
    this.rows.update(rows => rows.map(r => (r.index === index ? { ...r, selected } : r)));
  }

  toggleAll(selected: boolean): void {
    this.rows.update(rows => rows.map(r => ({ ...r, selected })));
  }

  setCategory(index: number, category: Category | null): void {
    this.rows.update(rows => rows.map(r => (r.index === index ? { ...r, category } : r)));
  }

  async submit(): Promise<void> {
    const selected = this.rows().filter(r => r.selected);
    if (selected.length === 0) return;

    this.loading.set(true);
    try {
      const payload = selected.map(r => ({
        date: r.date,
        amount: r.amount,
        description: r.description,
        payee: r.payee,
        hash: r.hash,
        // null lets the server apply its own Uncategorized default rather
        // than this screen guessing one.
        categoryId: r.category?.id ?? null,
      }));
      const response = await firstValueFrom(this.api.reconcileImport(this.account.id, payload));
      if (response.data) {
        this.context.completeWith(response.data);
      }
    } catch (e) {
      this.notifications.showError(e, 'Failed to import transactions');
    } finally {
      this.loading.set(false);
    }
  }

  protected cancel(): void {
    this.context.completeWith(null);
  }
}
