import { inject, Injectable, INJECTOR } from '@angular/core';
import { TuiDialogService } from '@taiga-ui/core';
import { PolymorpheusComponent } from '@taiga-ui/polymorpheus';
import { firstValueFrom } from 'rxjs';
import type { Account } from '../../models/account';
import type { ImportParseResult, ImportReconcileResult } from '../../models/import';
import { TransactionsState } from '../../core/transactions.state';
import { AccountsState } from '../../core/accounts.state';
import { NotificationService } from '../../core/notification.service';
import { ApiService } from '../../core/api.service';

/**
 * Runs the import as two dialogs in sequence: upload (which parses) and
 * review (which reconciles).
 *
 * There is deliberately no way back from review to upload. The parsed rows
 * depend on the file and format chosen in the first step, so "back" would
 * either re-parse — which is just uploading again — or leave stale rows on
 * screen. Cancelling review discards the parse.
 */
@Injectable({ providedIn: 'root' })
export class ImportDialogService {
  private readonly dialogs = inject(TuiDialogService);
  private readonly injector = inject(INJECTOR);
  private readonly transactions = inject(TransactionsState);
  private readonly accounts = inject(AccountsState);
  private readonly notifications = inject(NotificationService);
  private readonly api = inject(ApiService);

  async open(account: Account): Promise<ImportReconcileResult | null> {
    let result: ImportReconcileResult | null;
    try {
      const parsed = await this.openUpload(account);
      if (!parsed) return null;

      if (parsed.rows.length === 0) {
        this.notifications.showError('This statement has no transactions to import');
        return null;
      }

      result = await this.openReview(parsed);
    } catch (e) {
      this.notifications.showError(e, 'Failed to open import');
      return null;
    }
    return this.finish(result);
  }

  /**
   * Loads the account's new transactions from its linked bank into the review.
   * The first load asks how far back to go; later ones continue from the marker.
   */
  async openFromBank(account: Account): Promise<ImportReconcileResult | null> {
    let result: ImportReconcileResult | null;
    try {
      let dateFrom: string | undefined;
      if (!account.bank_link?.loadedTo) {
        const picked = await this.openBankLoad();
        if (!picked) return null;
        dateFrom = picked;
      }

      const parsed = (await firstValueFrom(this.api.loadFromBank(account.id, dateFrom))).data;
      if (!parsed) return null;

      if (parsed.rows.length === 0) {
        // Nothing to review, but the window was still checked: move the marker.
        const marked = await firstValueFrom(this.api.reconcileImport(account.id, [], parsed.bank?.dateTo));
        this.reloadLists();
        this.notifications.showSuccess('No new transactions in the bank');
        return marked.data ?? null;
      }

      result = await this.openReview(parsed);
    } catch (e) {
      this.notifications.showError(e, 'Failed to load from the bank');
      return null;
    }
    return this.finish(result);
  }

  private finish(result: ImportReconcileResult | null): ImportReconcileResult | null {
    if (!result) return null;
    this.reloadLists();
    const imported = `${result.created} transaction${result.created === 1 ? '' : 's'} imported`;
    this.notifications.showSuccess(
      result.skipped > 0 ? `${imported}, ${result.skipped} already present` : imported
    );
    return result;
  }

  /** Reconcile reports only counts, so the lists have to be refetched; balances move too, hence both. */
  private reloadLists(): void {
    this.transactions.reload();
    this.accounts.reload();
  }

  private async openBankLoad(): Promise<string | null> {
    const { BankLoad } = await import('../bank/bank-load/bank-load');
    return firstValueFrom(
      this.dialogs.open<string | null>(
        new PolymorpheusComponent(BankLoad, this.injector),
        { label: 'Load from bank', size: 's', dismissible: false }
      ),
      { defaultValue: null }
    );
  }

  private async openUpload(account: Account): Promise<ImportParseResult | null> {
    const { ImportUpload } = await import('./import-upload/import-upload');
    return firstValueFrom(
      this.dialogs.open<ImportParseResult | null>(
        new PolymorpheusComponent(ImportUpload, this.injector),
        { data: account, label: 'Import statement', size: 's', dismissible: false }
      ),
      { defaultValue: null }
    );
  }

  private async openReview(parsed: ImportParseResult): Promise<ImportReconcileResult | null> {
    const { ImportReview } = await import('./import-review/import-review');
    return firstValueFrom(
      this.dialogs.open<ImportReconcileResult | null>(
        new PolymorpheusComponent(ImportReview, this.injector),
        { data: parsed, label: `Import into ${parsed.account.name}`, size: null, dismissible: false }
      ),
      { defaultValue: null }
    );
  }
}
