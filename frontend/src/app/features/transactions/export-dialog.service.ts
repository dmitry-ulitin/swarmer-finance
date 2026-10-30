import { inject, Injectable, INJECTOR } from '@angular/core';
import { TuiDialogService } from '@taiga-ui/core';
import { PolymorpheusComponent } from '@taiga-ui/polymorpheus';
import { firstValueFrom } from 'rxjs';
import { NotificationService } from '../../core/notification.service';

@Injectable({ providedIn: 'root' })
export class ExportDialogService {
  private readonly dialogs = inject(TuiDialogService);
  private readonly injector = inject(INJECTOR);
  private readonly notifications = inject(NotificationService);

  async open(): Promise<boolean> {
    try {
      const { ExportStatement } = await import('./export-statement/export-statement');
      return await firstValueFrom(
        this.dialogs.open<boolean>(
          new PolymorpheusComponent(ExportStatement, this.injector),
          { label: 'Export transactions', size: 's' }
        ),
        { defaultValue: false }
      );
    } catch (e) {
      this.notifications.showError(e, 'Failed to open export');
      return false;
    }
  }
}
