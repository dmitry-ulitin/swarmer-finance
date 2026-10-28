import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { of } from 'rxjs';
import { TuiDay } from '@taiga-ui/cdk/date-time';
import { TuiDialogService } from '@taiga-ui/core';
import { POLYMORPHEUS_CONTEXT } from '@taiga-ui/polymorpheus';
import { AccountValuations } from './account-valuations';
import { AccountsState } from '../../../core/accounts.state';
import { NotificationService } from '../../../core/notification.service';
import type { Valuation } from '../../../models/valuation';

const flushAsync = () => new Promise(resolve => setTimeout(resolve));

const v = (id: number, as_of: string, value: number): Valuation =>
  ({ id, account_id: 7, as_of, value, user_id: 1, created_at: '2026-01-01T00:00:00Z' });

async function setup(accessLevel: number, valuations: Valuation[]) {
  const accounts = { reload: vi.fn() };
  const dialogOpen = vi.fn(() => of(true));
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: POLYMORPHEUS_CONTEXT, useValue: { data: { id: 7, name: 'Fund', currency: 'USD', scale: 2, access_level: accessLevel } } },
      { provide: TuiDialogService, useValue: { open: dialogOpen } },
      { provide: AccountsState, useValue: accounts },
      { provide: NotificationService, useValue: { showError: vi.fn() } },
    ],
  });
  const fixture = TestBed.createComponent(AccountValuations);
  const http = TestBed.inject(HttpTestingController);
  http.expectOne('/api/accounts/7/valuations').flush({ data: valuations, error: null });
  await flushAsync();
  fixture.detectChanges();
  return { fixture, component: fixture.componentInstance, http, accounts, dialogOpen };
}

describe('AccountValuations', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('renders the rows newest first', async () => {
    const { fixture } = await setup(2, [v(1, '2026-01-10', 100), v(2, '2026-03-10', 300), v(3, '2026-02-10', 200)]);
    const rows = Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('[data-test="row"]'));
    expect(rows.map(r => r.querySelector('[data-test="date"]')?.textContent?.trim())).toEqual(['2026-03-10', '2026-02-10', '2026-01-10']);
    expect(rows[0].textContent).toContain('$300.00');
  });

  it('creates a valuation with { asOf, value }', async () => {
    const { component, http, accounts } = await setup(2, []);
    component.form.setValue({ date: new TuiDay(2026, 0, 5), value: 1500 });
    const done = component.submit();
    await flushAsync();
    const req = http.expectOne('/api/accounts/7/valuations');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ asOf: '2026-01-05', value: 1500 });
    req.flush({ data: v(5, '2026-01-05', 1500), error: null });
    await flushAsync();
    http.expectOne('/api/accounts/7/valuations').flush({ data: [v(5, '2026-01-05', 1500)], error: null });
    await done;
    expect(accounts.reload).toHaveBeenCalled();
    expect(component.valuations().length).toBe(1);
  });

  it('shows the server message on a 409', async () => {
    const { fixture, component, http } = await setup(2, []);
    component.form.setValue({ date: new TuiDay(2026, 0, 5), value: 10 });
    const done = component.submit();
    await flushAsync();
    http.expectOne('/api/accounts/7/valuations')
      .flush({ data: null, error: 'A valuation for this date already exists' }, { status: 409, statusText: 'Conflict' });
    await done;
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('[data-test="error"]')?.textContent)
      .toContain('A valuation for this date already exists');
  });

  it('hides the form and the row actions with READ access', async () => {
    const { fixture } = await setup(1, [v(1, '2026-01-10', 100)]);
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('form')).toBeNull();
    expect(el.querySelector('[data-test="delete"]')).toBeNull();
    expect(el.textContent).toContain('2026-01-10');
  });
});
