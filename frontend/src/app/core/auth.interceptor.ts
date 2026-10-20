import { HttpInterceptorFn, HttpErrorResponse, HttpRequest } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, switchMap, throwError } from 'rxjs';
import { AuthService } from './auth.service';
import { RefreshCoordinator } from './refresh-coordinator';

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const authService = inject(AuthService);
  const refreshCoordinator = inject(RefreshCoordinator);

  const withToken = (r: HttpRequest<unknown>, t: string) =>
    r.clone({ setHeaders: { Authorization: `Bearer ${t}` } });

  // Endpoints that manage their own auth state — never trigger refresh for them.
  const isAuthEndpoint =
    req.url.includes('/api/auth/refresh') ||
    req.url.includes('/api/auth/login') ||
    req.url.includes('/api/auth/register');

  const token = authService.getToken();
  return next(token ? withToken(req, token) : req).pipe(
    catchError((error: HttpErrorResponse) => {
      // A retry goes straight to `next`, past this handler, so a retry that
      // 401s again fails as is rather than starting another refresh.
      if (error.status !== 401 || isAuthEndpoint) {
        return throwError(() => error);
      }

      // A refresh may have already completed while this 401 was in
      // flight (e.g. a sibling request's refresh round finished first).
      // In that case the stored token is already newer than the one
      // this request was sent with — just retry with it instead of
      // triggering a redundant /api/auth/refresh call.
      const currentToken = authService.getToken();
      if (currentToken && currentToken !== token) {
        return next(withToken(req, currentToken));
      }

      // Single-flight: all concurrent 401s share one /api/auth/refresh call.
      return refreshCoordinator.refresh().pipe(
        switchMap(newToken => next(withToken(req, newToken))),
      );
    }),
  );
};