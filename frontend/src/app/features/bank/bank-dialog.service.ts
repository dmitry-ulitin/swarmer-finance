import { inject, Injectable, INJECTOR } from '@angular/core';
import { TuiDialogService } from '@taiga-ui/core';
import { PolymorpheusComponent } from '@taiga-ui/polymorpheus';
import { firstValueFrom } from 'rxjs';
import { NotificationService } from '../../core/notification.service';

@Injectable({ providedIn: 'root' })
export class BankDialogService {
  private readonly dialogs = inject(TuiDialogService);
  private readonly injector = inject(INJECTOR);
  private readonly notifications = inject(NotificationService);

  async openConnections(): Promise<void> {
    try {
      const { BankConnections } = await import('./bank-connections/bank-connections');
      await firstValueFrom(
        this.dialogs.open<void>(
          new PolymorpheusComponent(BankConnections, this.injector),
          { label: 'Bank connections', size: 'm' }
        ),
        { defaultValue: undefined }
      );
    } catch (e) {
      this.notifications.showError(e, 'Failed to open bank connections');
    }
  }
}
