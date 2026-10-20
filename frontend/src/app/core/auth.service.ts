import { Injectable, signal, computed, inject } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { Observable, throwError } from 'rxjs';
import { map, tap } from 'rxjs/operators';
import type { ApiResponse } from './api.service';

export interface User {
  id: number;
  email: string;
  name: string;
  currency: string;
  currency_scale: number;
}

export interface AuthResponse {
  user: User;
  accessToken: string;
  refreshToken: string;
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private readonly http = inject(HttpClient);
  private readonly router = inject(Router);

  private accessToken = signal<string | null>(localStorage.getItem('accessToken'));
  private userSignal = signal<User | null>(this.accessToken() ? this.storedUser() : null);

  readonly isAuthenticated = computed(() => !!this.accessToken());
  readonly user = computed(() => this.userSignal());

  private storedUser(): User | null {
    const storedUser = localStorage.getItem('user');
    return storedUser ? JSON.parse(storedUser) : null;
  }

  register(email: string, password: string, name: string, currency: string) {
    return this.http.post<ApiResponse<AuthResponse>>('/api/auth/register', { email, password, name, currency })
      .pipe(tap(response => this.handleAuth(response.data)));
  }

  login(email: string, password: string) {
    return this.http.post<ApiResponse<AuthResponse>>('/api/auth/login', { email, password })
      .pipe(tap(response => this.handleAuth(response.data)));
  }

  logout() {
    localStorage.removeItem('accessToken');
    localStorage.removeItem('refreshToken');
    localStorage.removeItem('user');
    this.accessToken.set(null);
    this.userSignal.set(null);
    this.router.navigate(['/login']);
  }

  getToken(): string | null {
    return this.accessToken();
  }

  refreshToken(): Observable<string> {
    const token = this.getRefreshToken();
    if (!token) {
      this.logout();
      return throwError(() => new Error('No refresh token'));
    }
    return this.performRefresh(token);
  }

  /**
   * Internal: performs the actual /api/auth/refresh HTTP call.
   * Returns an Observable that emits the new access token on success.
   * Used by RefreshCoordinator for single-flight gating; do not call
   * directly from feature code.
   */
  performRefresh(refreshToken: string): Observable<string> {
    return this.http
      .post<ApiResponse<AuthResponse>>('/api/auth/refresh', { refreshToken })
      .pipe(
        tap(response => this.handleAuth(response.data)),
        map(response => response.data!.accessToken)
      );
  }

  getRefreshToken(): string | null {
    return localStorage.getItem('refreshToken');
  }

  private handleAuth(data: AuthResponse | null) {
    if (!data) return;
    localStorage.setItem('accessToken', data.accessToken);
    localStorage.setItem('refreshToken', data.refreshToken);
    localStorage.setItem('user', JSON.stringify(data.user));
    this.accessToken.set(data.accessToken);
    this.userSignal.set(data.user);
  }
}
