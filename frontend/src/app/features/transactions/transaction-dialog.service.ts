import { inject, Injectable, INJECTOR } from '@angular/core';
import { TuiDialogService } from '@taiga-ui/core';
import { PolymorpheusComponent } from '@taiga-ui/polymorpheus';
import { firstValueFrom } from 'rxjs';
import type { Transaction } from '../../models/transaction';

@Injectable({ providedIn: 'root' })
export class TransactionDialogService {
  private readonly dialogs = inject(TuiDialogService);
  private readonly injector = inject(INJECTOR);

  async openCreate(): Promise<Transaction | null> {
    const { TransactionForm } = await import('./transaction-form/transaction-form');
    return firstValueFrom(
      this.dialogs.open<Transaction | null>(
        new PolymorpheusComponent(TransactionForm, this.injector),
        { data: null, label: 'Add Transaction', size: 'm' }
      ),
      { defaultValue: null }
    );
  }
}
