import { describe, it, expect, vi } from 'vitest';
import { HttpErrorResponse, HttpRequest, HttpHandlerFn, HttpEvent } from '@angular/common/http';
import { TestBed } from '@angular/core/testing';
import { Observable, Subject, of, throwError } from 'rxjs';
import { authInterceptor } from './auth.interceptor';
import { AuthService } from './auth.service';
import { RefreshCoordinator } from './refresh-coordinator';

/**
 * Reproduces a race in the dashboard: accounts/categories/transactions
 * requests are all sent with the same about-to-expire access token.
 * accounts+categories 401 and share one refresh. transactions' 401
 * arrives late -- AFTER that refresh round has already completed and
 * cleared the single-flight gate -- so its catchError starts a second,
 * redundant /api/auth/refresh call instead of just retrying with the
 * already-current token.
 */
describe('authInterceptor', () => {
  it('does not trigger a second refresh for a late-arriving 401 that used the pre-refresh token', async () => {
    const oldToken = 'old-token';
    const newToken = 'new-token';

    let currentToken = oldToken;
    const authService = {
      getToken: vi.fn(() => currentToken),
    } as unknown as AuthService;

    const refreshResult = new Subject<string>();
    const refreshCoordinator = {
      refresh: vi.fn(() => refreshResult.asObservable()),
    } as unknown as RefreshCoordinator;

    TestBed.configureTestingModule({
      providers: [
        { provide: AuthService, useValue: authService },
        { provide: RefreshCoordinator, useValue: refreshCoordinator },
      ],
    });

    const run = (req: HttpRequest<unknown>, next: HttpHandlerFn) =>
      TestBed.runInInjectionContext(() => authInterceptor(req, next));

    // Request A (e.g. accounts): 401s immediately with the stale token.
    const reqA = new HttpRequest('GET', '/api/accounts');
    const nextA: HttpHandlerFn = (r) =>
      r.headers.has('X-Retry-After-Refresh')
        ? (of({} as HttpEvent<unknown>))
        : throwError(() => new HttpErrorResponse({ status: 401 }));

    // Request B (e.g. transactions): also sent with the stale token, but
    // its 401 response arrives late -- after refresh A has already
    // completed and cleared the gate.
    const lateFailure = new Subject<HttpEvent<unknown>>();
    const nextB: HttpHandlerFn = (r) =>
      r.headers.has('X-Retry-After-Refresh')
        ? of({} as HttpEvent<unknown>)
        : (lateFailure.asObservable() as Observable<HttpEvent<unknown>>);

    // Both A and B are sent while currentToken is still oldToken.
    run(reqA, nextA).subscribe();
    const reqB = new HttpRequest('GET', '/api/transactions');
    const doneB: unknown[] = [];
    run(reqB, nextB).subscribe({ next: v => doneB.push(v) });

    expect(refreshCoordinator.refresh).toHaveBeenCalledTimes(1);

    // Refresh A resolves: the coordinator's single-flight window closes
    // and AuthService now reports the new token.
    currentToken = newToken;
    refreshResult.next(newToken);
    refreshResult.complete();

    // Now request B's 401 finally arrives, late -- after the gate closed.
    lateFailure.error(new HttpErrorResponse({ status: 401 }));

    // It must NOT start a second refresh round -- the token is already
    // fresh, so it should just retry with the current token.
    expect(refreshCoordinator.refresh).toHaveBeenCalledTimes(1);
  });
});
