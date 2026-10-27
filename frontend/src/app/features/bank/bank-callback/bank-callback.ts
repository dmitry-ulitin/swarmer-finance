import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { ActivatedRoute, Router } from '@angular/router';
import { TuiLoader } from '@taiga-ui/core';
import { firstValueFrom } from 'rxjs';
import { ApiService } from '../../../core/api.service';
import { NotificationService } from '../../../core/notification.service';
import { BankDialogService } from '../bank-dialog.service';

/** Where the bank sends the user back after consent; finishes the connection. */
@Component({
  selector: 'app-bank-callback',
  imports: [TuiLoader],
  template: '<tui-loader size="l" />',
  styles: ':host { display: block; min-height: 50vh; }',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class BankCallback {
  private readonly api = inject(ApiService);
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly notifications = inject(NotificationService);
  private readonly bankDialogs = inject(BankDialogService);

  constructor() {
    void this.complete();
  }

  private async complete(): Promise<void> {
    const query = this.route.snapshot.queryParamMap;
    const state = query.get('state');
    const code = query.get('code');
    const error = query.get('error');
    try {
      if (error || !state || !code) {
        this.notifications.showError(error ? `The bank returned an error: ${error}` : 'Unknown or expired connection request');
      } else {
        await firstValueFrom(this.api.completeBankConnection(state, code));
        this.notifications.showSuccess('Bank connected');
      }
    } catch (e) {
      this.notifications.showError(e, 'Failed to connect the bank');
    }
    await this.router.navigate(['/dashboard'], { replaceUrl: true });
    void this.bankDialogs.openConnections();
  }
}
