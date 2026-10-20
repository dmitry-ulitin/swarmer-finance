import { describe, it, expect, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { provideRouter } from '@angular/router';
import { AuthService } from './auth.service';

const user = { id: 1, email: 'a@b.c', name: 'A', currency: 'EUR', currency_scale: 2 };

function create(): AuthService {
  TestBed.configureTestingModule({ providers: [provideHttpClient(), provideRouter([])] });
  return TestBed.inject(AuthService);
}

describe('AuthService on start', () => {
  afterEach(() => localStorage.clear());

  it('restores the session from storage', () => {
    localStorage.setItem('accessToken', 'token');
    localStorage.setItem('user', JSON.stringify(user));
    const auth = create();
    expect(auth.isAuthenticated()).toBe(true);
    expect(auth.getToken()).toBe('token');
    expect(auth.user()).toEqual(user);
  });

  it('ignores a stored user without a token', () => {
    localStorage.setItem('user', JSON.stringify(user));
    const auth = create();
    expect(auth.isAuthenticated()).toBe(false);
    expect(auth.user()).toBeNull();
  });
});
