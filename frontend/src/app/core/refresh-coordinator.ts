import { Injectable } from '@angular/core';
import { Observable, Subject, Subscription, throwError } from 'rxjs';
import { catchError, tap } from 'rxjs/operators';
import { AuthService } from './auth.service';

/**
 * Single-flight gate for access-token refresh.
 *
 * Why: when multiple parallel HTTP requests get 401 simultaneously,
 * each interceptor call must NOT trigger its own /api/auth/refresh call.
 * With refresh-token rotation, only the first call uses a still-valid
 * refresh token; subsequent parallel refresh calls get 401 and the
 * interceptor's catchError calls authService.logout() — kicking the
 * user out even though one refresh would have sufficed.
 *
 * Contract:
 *   - First call to refresh() starts a single underlying refresh.
 *   - All concurrent calls to refresh() within the window share the
 *     SAME result via a multicast Subject.
 *   - When the underlying refresh completes (success or error), the
 *     gate clears so the next refresh() call starts a new round.
 *   - If refresh fails, authService.logout() is invoked exactly once.
 *
 * Implementation: we manually wire a Subject and subscribe to the
 * source Observable ourselves exactly once. Concurrent refresh()
 * callers all subscribe to the same Subject. The gate is cleared
 * only AFTER the source settles and the Subject's last subscriber
 * receives the final value — guaranteeing concurrent callers in the
 * same tick see the same single underlying HTTP call.
 */
@Injectable({ providedIn: 'root' })
export class RefreshCoordinator {
  private inflight: { subject: Subject<string>; subscription: Subscription } | null = null;

  constructor(private readonly auth: AuthService) {}

  refresh(): Observable<string> {
    if (this.inflight) {
      return this.inflight.subject.asObservable();
    }

    const refreshToken = this.auth.getRefreshToken();
    if (!refreshToken) {
      this.auth.logout();
      return throwError(() => new Error('No refresh token'));
    }

    const subject = new Subject<string>();
    const source$ = this.auth.performRefresh(refreshToken).pipe(
      tap(() => {/* success: AuthService has stored new tokens */}),
      catchError((err: unknown) => {
        this.auth.logout();
        return throwError(() => err);
      }),
    );

    // Subscribe to the source ourselves and pipe emissions into the
    // Subject. Only ONE underlying HTTP refresh call is made per round.
    const subscription = source$.subscribe({
      next: token => subject.next(token),
      error: err => {
        subject.error(err);
        // Clear the gate only AFTER the Subject has broadcast the error.
        // Subscribers that subscribe synchronously before this point
        // (e.g. inside the same microtask) will still hit the cached
        // inflight and receive the same error without triggering a new
        // round.
        this.inflight = null;
      },
      complete: () => {
        subject.complete();
        this.inflight = null;
      },
    });

    this.inflight = { subject, subscription };
    return subject.asObservable();
  }

  /**
   * Test/debug helper: is a refresh currently in flight?
   */
  isRefreshing(): boolean {
    return this.inflight !== null;
  }
}