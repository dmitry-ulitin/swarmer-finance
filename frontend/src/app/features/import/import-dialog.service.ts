import { inject, Injectable, INJECTOR } from '@angular/core';
import { TuiDialogService } from '@taiga-ui/core';
import { PolymorpheusComponent } from '@taiga-ui/polymorpheus';
import { firstValueFrom } from 'rxjs';
import type { Account } from '../../models/account';
import type { ImportParseResult, ImportReconcileResult } from '../../models/import';
import { TransactionsState } from '../../core/transactions.state';
import { AccountsState } from '../../core/accounts.state';
import { NotificationService } from '../../core/notification.service';
import { describeImport } from './import-summary';

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

  async open(account: Account): Promise<ImportReconcileResult | null> {
    const parsed = await this.openUpload(account);
    if (!parsed) return null;

    if (parsed.rows.length === 0) {
      this.notifications.showError('This statement has no transactions to import');
      return null;
    }

    const result = await this.openReview(parsed);
    if (!result) return null;

    // Reconcile reports only counts, so the lists have to be refetched;
    // balances move too, hence both.
    this.transactions.reload();
    this.accounts.reload();
    this.notifications.showSuccess(describeImport(result));
    return result;
  }

  private async openUpload(account: Account): Promise<ImportParseResult | null> {
    const { ImportUpload } = await import('./import-upload/import-upload');
    return firstValueFrom(
      this.dialogs.open<ImportParseResult | null>(
        new PolymorpheusComponent(ImportUpload, this.injector),
        { data: account, label: 'Import statement', size: 's' }
      ),
      { defaultValue: null }
    );
  }

  private async openReview(parsed: ImportParseResult): Promise<ImportReconcileResult | null> {
    const { ImportReview } = await import('./import-review/import-review');
    return firstValueFrom(
      this.dialogs.open<ImportReconcileResult | null>(
        new PolymorpheusComponent(ImportReview, this.injector),
        { data: parsed, label: `Import into ${parsed.account.name}`, size: 'l' }
      ),
      { defaultValue: null }
    );
  }
}
