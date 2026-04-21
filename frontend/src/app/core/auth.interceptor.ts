import { HttpInterceptorFn, HttpErrorResponse, HttpRequest } from '@angular/common/http';
import { inject } from '@angular/core';
import { catchError, switchMap, throwError } from 'rxjs';
import { AuthService } from './auth.service';

export const authInterceptor: HttpInterceptorFn = (req, next) => {
  const authService = inject(AuthService);

  const withToken = (r: HttpRequest<unknown>, t: string) =>
    r.clone({ setHeaders: { Authorization: `Bearer ${t}` } });

  const token = authService.getToken();
  return next(token ? withToken(req, token) : req).pipe(
    catchError((error: HttpErrorResponse) => {
      if (error.status !== 401 || req.url.includes('/api/auth/refresh') || req.url.includes('/api/auth/login')) {
        return throwError(() => error);
      }
      return authService.refreshToken().pipe(
        switchMap(newToken => next(withToken(req, newToken))),
        catchError(refreshErr => {
          authService.logout();
          return throwError(() => refreshErr);
        }),
      );
    }),
  );
};
