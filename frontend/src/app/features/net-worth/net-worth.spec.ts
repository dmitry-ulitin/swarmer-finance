import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { of } from 'rxjs';
import { NetWorthPage } from './net-worth';
import { ApiService } from '../../core/api.service';
import { AccountsState } from '../../core/accounts.state';
import { AuthService } from '../../core/auth.service';
import { NotificationService } from '../../core/notification.service';
import type { NetWorth } from '../../models/net-worth';

const flushAsync = () => new Promise(resolve => setTimeout(resolve));

const zero = { cash: 0, bank: 0, crypto: 0, investment: 0, property: 0, deposit: 0 };

const data = (approximate = false): NetWorth => ({
  currency: 'EUR',
  total: 1500,
  approximate,
  byType: [{ type: 'bank', value: 300 }, { type: 'investment', value: 1200 }],
  byCurrency: [{ currency: 'EUR', value: 1500 }],
  accounts: [
    { id: 1, name: 'Main', type: 'bank', currency: 'EUR', value: 300, valueUser: 300, invested: 0, gain: 0, gainPct: null, inNetWorth: true },
    { id: 3, name: 'Wallet', type: 'crypto', currency: 'BTC', value: 0.12345678, valueUser: 0, invested: 0, gain: 0, gainPct: null, inNetWorth: true },
    { id: 2, name: 'Fund', type: 'investment', currency: 'EUR', value: 1200, valueUser: 1200, invested: 1000, gain: 200, gainPct: 20, inNetWorth: true },
  ],
  history: [
    { date: '2026-09-30', total: 1000, byType: { ...zero, bank: 300, investment: 700 }, approximate: false },
    { date: '2026-10-28', total: 1500, byType: { ...zero, bank: 300, investment: 1200 }, approximate, },
  ],
});

async function setup(approximate = false, user = { currency: 'EUR', currency_scale: 2 }) {
  const getNetWorth = vi.fn(() => of({ data: data(approximate), error: null }));
  const setInNetWorth = vi.fn(() => of({}));
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: ApiService, useValue: { getNetWorth } },
      { provide: AccountsState, useValue: { setInNetWorth } },
      { provide: AuthService, useValue: { isAuthenticated: () => true, user: () => user } },
      { provide: NotificationService, useValue: { showError: vi.fn() } },
    ],
  });
  const fixture = TestBed.createComponent(NetWorthPage);
  fixture.detectChanges();
  await flushAsync();
  fixture.detectChanges();
  return { fixture, component: fixture.componentInstance, el: fixture.nativeElement as HTMLElement, getNetWorth, setInNetWorth };
}

describe('NetWorthPage', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('shows the gain in money and percent only when gainPct is set', async () => {
    const { el } = await setup();
    const gain = (id: number) => el.querySelector(`[data-test="row"][data-id="${id}"] [data-test="gain"]`)?.textContent?.trim();
    expect(gain(2)).toBe('€200.00 (+20%)');
    expect(gain(1)).toBe('');
  });

  it('renders the total as formatted money', async () => {
    const { el } = await setup();
    expect(el.querySelector('[data-test="total"]')?.textContent).toContain('€1,500.00');
  });

  it('shows the approximate mark only when approximate', async () => {
    const exact = await setup(false);
    expect(exact.el.querySelector('[data-test="total"]')?.textContent).not.toContain('≈');
    TestBed.resetTestingModule();
    const approx = await setup(true);
    expect(approx.el.querySelector('[data-test="total"]')?.textContent).toContain('≈');
  });

  it('unchecking a row calls setInNetWorth and refetches', async () => {
    const { el, fixture, getNetWorth, setInNetWorth } = await setup();
    expect(getNetWorth).toHaveBeenCalledTimes(1);
    const box = el.querySelector<HTMLInputElement>('[data-test="row"][data-id="2"] input[type="checkbox"]')!;
    box.click();
    await flushAsync();
    fixture.detectChanges();
    await flushAsync();
    expect(setInNetWorth).toHaveBeenCalledWith(2, false);
    expect(getNetWorth).toHaveBeenCalledTimes(2);
  });

  it('formats user-currency amounts at the user scale', async () => {
    const { el } = await setup(false, { currency: 'JPY', currency_scale: 0 });
    const total = el.querySelector('[data-test="total"]')?.textContent ?? '';
    expect(total).toContain('1,500');
    expect(total).not.toContain('.');
  });

  it('formats account values at the account currency scale', async () => {
    const { el } = await setup();
    const row = el.querySelector('[data-test="row"][data-id="3"]')?.textContent ?? '';
    expect(row).toContain('0.12345678');
  });

  it('gives the bar chart one series per type with a non-zero value', async () => {
    const { component } = await setup();
    expect(component.series().map(s => s.type)).toEqual(['bank', 'investment']);
    expect(component.series().map(s => s.values)).toEqual([[300, 300], [700, 1200]]);
  });
});
