import { inject, Injectable, INJECTOR } from '@angular/core';
import { TuiDialogService } from '@taiga-ui/core';
import { PolymorpheusComponent } from '@taiga-ui/polymorpheus';
import { firstValueFrom } from 'rxjs';
import { NotificationService } from '../../core/notification.service';

@Injectable({ providedIn: 'root' })
export class ProfileDialogService {
  private readonly dialogs = inject(TuiDialogService);
  private readonly injector = inject(INJECTOR);
  private readonly notifications = inject(NotificationService);

  async open(): Promise<boolean> {
    try {
      const { ProfileForm } = await import('./profile-form');
      return await firstValueFrom(
        this.dialogs.open<boolean>(
          new PolymorpheusComponent(ProfileForm, this.injector),
          { label: 'Profile', size: 's' }
        ),
        { defaultValue: false }
      );
    } catch (e) {
      this.notifications.showError(e, 'Failed to open profile');
      return false;
    }
  }
}
