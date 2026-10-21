import { describe, it, expect, beforeEach, vi } from 'vitest';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { Dashboard } from './dashboard';
import { ApiService } from '../../core/api.service';
import { AuthService } from '../../core/auth.service';
import { NotificationService } from '../../core/notification.service';

describe('Dashboard', () => {
  let getTransactions: ReturnType<typeof vi.fn>;
  let getCategorySummary: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    TestBed.resetTestingModule();
    vi.stubGlobal('IntersectionObserver', class {
      observe() {}
      disconnect() {}
    });
    getTransactions = vi.fn(() => of({ data: [], error: null }));
    getCategorySummary = vi.fn(() => of({ data: { currency: 'EUR', scale: 2, income: [], expense: [] }, error: null }));
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        {
          provide: ApiService,
          useValue: {
            getTransactions,
            getCategorySummary,
            getAccounts: () => of({ data: [], error: null }),
            getCategories: () => of({ data: [], error: null }),
          },
        },
        {
          provide: AuthService,
          useValue: {
            isAuthenticated: signal(true),
            user: signal({ id: 1, email: 'a@b.c', name: 'A', currency: 'EUR', currency_scale: 2 }),
          },
        },
        { provide: NotificationService, useValue: { showError: vi.fn() } },
      ],
    });
  });

  it('loads the transactions and the summary once on entry', async () => {
    const fixture = TestBed.createComponent(Dashboard);
    await fixture.whenStable();

    expect(getTransactions).toHaveBeenCalledTimes(1);
    expect(getCategorySummary).toHaveBeenCalledTimes(1);
  });
});
