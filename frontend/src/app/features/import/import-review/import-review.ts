import { ChangeDetectionStrategy, Component, computed, inject, signal } from '@angular/core';
import { TuiButton, TuiCheckbox, TuiHint, TuiIcon, TuiLoader } from '@taiga-ui/core';
import type { TuiDialogContext } from '@taiga-ui/core';
import { POLYMORPHEUS_CONTEXT } from '@taiga-ui/polymorpheus';
import { firstValueFrom } from 'rxjs';
import { DatePipe } from '@angular/common';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../../core/api.service';
import { NotificationService } from '../../../core/notification.service';
import { MoneyPipe } from '../../../core/money.pipe';
import { CategorySelect } from '../../categories/category-select/category-select';
import { CategoriesState } from '../../../core/categories.state';
import { findCategoryById } from '../../../models/category';
import type { Category } from '../../../models/category';
import { IMPORT_FORMATS } from '../../../models/import';
import type {
  ImportParseResult,
  ImportReconcileResult,
  ImportRow,
  ImportRowStatus,
} from '../../../models/import';

/** A parsed row plus the things the user controls on this screen. */
export interface ReviewRow extends ImportRow {
  selected: boolean;
  /** The user's own pick; ignored while `suggested` is true. */
  category: Category | null;
  /** True until the user touches the category: the server's suggestion stands. */
  suggested: boolean;
}

const STATUS_LABEL: Record<ImportRowStatus, string> = {
  new: 'New',
  duplicate: 'Duplicate',
  possible_duplicate: 'Possible duplicate',
};

const STATUS_ICON: Record<ImportRowStatus, string> = {
  new: '@tui.circle-plus',
  duplicate: '@tui.copy',
  possible_duplicate: '@tui.circle-alert',
};

@Component({
  selector: 'app-import-review',
  imports: [
    FormsModule,
    DatePipe,
    TuiCheckbox,
    TuiButton,
    TuiLoader,
    TuiIcon,
    TuiHint,
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
  private readonly categories = inject(CategoriesState);

  readonly result = this.context.data;
  readonly account = this.result.account;
  readonly summary = this.result.summary;
  readonly formatName =
    IMPORT_FORMATS.find(f => f.id === this.result.format)?.name ?? this.result.format;

  /**
   * Only new rows start selected. Exact duplicates are hashes the server has
   * already seen; possible duplicates match a hand-entered transaction, so the
   * user opts them in after checking.
   */
  readonly rows = signal<ReviewRow[]>(
    this.result.rows.map(row => ({
      ...row,
      selected: row.status === 'new',
      category: null,
      suggested: row.suggestedCategoryId !== null,
    }))
  );

  readonly loading = signal(false);
  readonly selectedCount = computed(() => this.rows().filter(r => r.selected).length);
  readonly allSelected = computed(
    () => this.rows().length > 0 && this.selectedCount() === this.rows().length
  );

  readonly statusLabel = (status: ImportRowStatus): string => STATUS_LABEL[status];

  readonly statusIcon = (status: ImportRowStatus): string => STATUS_ICON[status];

  /** 1 = Income, 2 = Expenses, following the row's own sign. */
  readonly rootIdFor = (row: ReviewRow): number => (row.amount < 0 ? 2 : 1);

  /**
   * The row's effective category: the server's suggestion until the user
   * picks one. Looked up on read rather than once at construction, so a
   * suggestion still lands when the category tree loads after the dialog
   * opens; an id missing from the tree resolves to no category.
   */
  readonly categoryOf = (row: ReviewRow): Category | null =>
    row.suggested
      ? findCategoryById(row.suggestedCategoryId ?? undefined, this.categories.categories())
      : row.category;

  readonly suggestionHint = (row: ReviewRow): string =>
    row.suggestionSource === 'mcc' ? 'Suggested by merchant type' : 'Suggested from history';

  toggle(index: number, selected: boolean): void {
    this.rows.update(rows => rows.map(r => (r.index === index ? { ...r, selected } : r)));
  }

  toggleAll(selected: boolean): void {
    this.rows.update(rows => rows.map(r => ({ ...r, selected })));
  }

  setCategory(index: number, category: Category | null): void {
    this.rows.update(rows =>
      rows.map(r => (r.index === index ? { ...r, category, suggested: false } : r))
    );
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
        categoryId: this.categoryOf(r)?.id ?? null,
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
