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
import { AccountSelect } from '../../accounts/account-select/account-select';
import { CategoriesState } from '../../../core/categories.state';
import { AccountsState } from '../../../core/accounts.state';
import { findCategoryById } from '../../../models/category';
import type { Category } from '../../../models/category';
import type { Account } from '../../../models/account';
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
  /** A transfer to (amount < 0) or from the other account; the category is then unused. */
  transfer: boolean;
  transferAccount: Account | null;
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
    AccountSelect,
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
  private readonly accounts = inject(AccountsState);

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
      transfer: false,
      transferAccount: null,
    }))
  );

  readonly loading = signal(false);
  readonly selectedCount = computed(() => this.rows().filter(r => r.selected).length);
  /** A selected transfer with no account cannot be imported. */
  readonly canSubmit = computed(
    () => this.selectedCount() > 0 && !this.rows().some(r => r.selected && r.transfer && !r.transferAccount)
  );
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

  /** The peer's side is converted at today's rate, so it may need a manual fix. */
  readonly isConverted = (row: ReviewRow): boolean =>
    row.transfer && !!row.transferAccount && row.transferAccount.currency !== this.account.currency;

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

  /** Switching to a transfer pre-picks an account in the same currency, if any. */
  setTransfer(index: number, transfer: boolean): void {
    const targets = this.accounts.transferTargets().filter(a => a.id !== this.account.id);
    const fallback =
      targets.find(a => a.currency === this.account.currency) ?? targets[0] ?? null;
    this.rows.update(rows =>
      rows.map(r =>
        r.index === index
          ? { ...r, transfer, transferAccount: transfer ? (r.transferAccount ?? fallback) : r.transferAccount }
          : r
      )
    );
  }

  setTransferAccount(index: number, transferAccount: Account | null): void {
    this.rows.update(rows => rows.map(r => (r.index === index ? { ...r, transferAccount } : r)));
  }

  async submit(): Promise<void> {
    if (!this.canSubmit()) return;
    const selected = this.rows().filter(r => r.selected);

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
        categoryId: r.transfer ? null : (this.categoryOf(r)?.id ?? null),
        transferAccountId: r.transfer ? r.transferAccount!.id : null,
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
