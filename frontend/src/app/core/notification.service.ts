import { HttpErrorResponse } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { TuiNotificationService } from '@taiga-ui/core';
import { ApiResponse } from './api.service';

@Injectable({
  providedIn: 'root',
})
export class NotificationService {
  private readonly notifications = inject(TuiNotificationService);

  showError(err: unknown, fallback?: string): void {
    this.notifications.open(this.extractErrorMessage(err, fallback), { label: 'Error', appearance: 'negative' }).subscribe();
  }

  showSuccess(message: string): void {
    this.notifications.open(message, { label: 'Success', appearance: 'positive' }).subscribe();
  }

  private extractErrorMessage(err: unknown, fallback: string | undefined): string {
    fallback = fallback || 'An unknown error occurred';
    if (err instanceof HttpErrorResponse) {
      const body = err.error as ApiResponse<unknown> | null;
      return body?.error || err.message || fallback;
    } else if (err instanceof Error) {
      return err.message || fallback ;
    } else if (typeof err === 'string') {
      return err || fallback;
    }
    return fallback;
  }
}
