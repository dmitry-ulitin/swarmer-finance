import { inject, Injectable, INJECTOR } from '@angular/core';
import { TUI_CONFIRM, TuiConfirmData } from '@taiga-ui/kit';
import { TuiDialogService } from '@taiga-ui/core';
import { PolymorpheusComponent } from '@taiga-ui/polymorpheus';
import { firstValueFrom } from 'rxjs';
import type { Account } from '../../models/account';
import { AuthService } from '../../core/auth.service';

@Injectable({ providedIn: 'root' })
export class AccountDialogService {
  private readonly dialogs = inject(TuiDialogService);
  private readonly auth = inject(AuthService);
  private readonly injector = inject(INJECTOR);

  async openCreate(): Promise<Account | null> {
    const { AccountForm } = await import('./account-form/account-form');
    return firstValueFrom(
      this.dialogs.open<Account | null>(
        new PolymorpheusComponent(AccountForm, this.injector),
        { data: { currency: this.auth.user()?.currency || 'EUR' }, label: 'Add Account', size: 's' }
      ),
      { defaultValue: null }
    );
  }

  async openEdit(account: Account): Promise<void> {
    const { AccountForm } = await import('./account-form/account-form');
    await firstValueFrom(
      this.dialogs.open<Account | null>(
        new PolymorpheusComponent(AccountForm, this.injector),
        { data: account, label: 'Edit Account', size: 's' }
      ),
      { defaultValue: null }
    );
  }

  async openDelete(account: Account): Promise<boolean> {
    const data: TuiConfirmData = {
      content: `Delete "${account.name}"?`,
      yes: 'Delete',
      no: 'Cancel',
    };
    return firstValueFrom(
      this.dialogs.open<boolean>(TUI_CONFIRM, { label: 'Delete Account', size: 's', data }),
      { defaultValue: false }
    );
  }
}
