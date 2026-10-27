import { inject, Injectable, INJECTOR } from '@angular/core';
import { TuiDialogService } from '@taiga-ui/core';
import { PolymorpheusComponent } from '@taiga-ui/polymorpheus';
import { firstValueFrom } from 'rxjs';
import { NotificationService } from '../../core/notification.service';

@Injectable({ providedIn: 'root' })
export class ChangePasswordDialogService {
  private readonly dialogs = inject(TuiDialogService);
  private readonly injector = inject(INJECTOR);
  private readonly notifications = inject(NotificationService);

  async open(): Promise<boolean> {
    try {
      const { ChangePassword } = await import('./change-password/change-password');
      return await firstValueFrom(
        this.dialogs.open<boolean>(
          new PolymorpheusComponent(ChangePassword, this.injector),
          { label: 'Change password', size: 's' }
        ),
        { defaultValue: false }
      );
    } catch (e) {
      this.notifications.showError(e, 'Failed to open password form');
      return false;
    }
  }
}
