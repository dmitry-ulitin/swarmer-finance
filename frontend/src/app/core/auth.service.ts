import { Injectable, signal, computed } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Router } from '@angular/router';
import { Observable, throwError } from 'rxjs';
import { map, tap } from 'rxjs/operators';

export interface User {
  id: number;
  email: string;
  name: string;
  currency: string;
}

export interface AuthResponse {
  user: User;
  accessToken: string;
  refreshToken: string;
}

export interface ApiResponse<T> {
  data: T | null;
  error: string | null;
}

@Injectable({ providedIn: 'root' })
export class AuthService {
  private accessToken = signal<string | null>(localStorage.getItem('accessToken'));
  private userSignal = signal<User | null>(null);

  readonly isAuthenticated = computed(() => !!this.accessToken());
  readonly user = computed(() => this.userSignal());

  constructor(private http: HttpClient, private router: Router) {
    const token = localStorage.getItem('accessToken');
    if (token) {
      this.accessToken.set(token);
      this.loadUser();
    }
  }

  private loadUser() {
    const storedUser = localStorage.getItem('user');
    if (storedUser) {
      this.userSignal.set(JSON.parse(storedUser));
    }
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
    const token = localStorage.getItem('refreshToken');
    if (!token) {
      this.logout();
      return throwError(() => new Error('No refresh token'));
    }
    return this.http
      .post<ApiResponse<AuthResponse>>('/api/auth/refresh', { refreshToken: token })
      .pipe(
        tap(response => this.handleAuth(response.data)),
        map(response => response.data!.accessToken)
      );
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
