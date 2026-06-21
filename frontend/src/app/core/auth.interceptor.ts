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

  // Guard against refresh-loop on retry: if the request is already
  // a retry after a refresh and the retry itself fails with 401,
  // we must not try to refresh again.
  const alreadyRetried = req.headers.has('X-Retry-After-Refresh');

  const token = authService.getToken();
  return next(token ? withToken(req, token) : req).pipe(
    catchError((error: HttpErrorResponse) => {
      if (error.status !== 401 || isAuthEndpoint || alreadyRetried) {
        return throwError(() => error);
      }

      // Single-flight: all concurrent 401s share one /api/auth/refresh call.
      return refreshCoordinator.refresh().pipe(
        switchMap(newToken =>
          next(withToken(req, newToken).clone({
            setHeaders: { 'X-Retry-After-Refresh': '1' },
          }))
        ),
        catchError(refreshErr => throwError(() => refreshErr)),
      );
    }),
  );
};