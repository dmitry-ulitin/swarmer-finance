import { describe, it, expect, vi } from 'vitest';
import { ApplicationRef, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { throwError } from 'rxjs';
import { CategoriesState } from './categories.state';
import { ApiService } from './api.service';
import { AuthService } from './auth.service';
import { NotificationService } from './notification.service';

describe('CategoriesState when the load fails', () => {
  it('shows no categories instead of throwing, and reports the error', async () => {
    const showError = vi.fn();
    TestBed.configureTestingModule({
      providers: [
        { provide: ApiService, useValue: { getCategories: () => throwError(() => new Error('down')) } },
        { provide: AuthService, useValue: { isAuthenticated: signal(true) } },
        { provide: NotificationService, useValue: { showError } },
      ],
    });
    const state = TestBed.inject(CategoriesState);
    await TestBed.inject(ApplicationRef).whenStable();
    expect(state.categories()).toEqual([]);
    expect(showError).toHaveBeenCalledWith(expect.any(Error), 'Failed to load categories');
  });
});
