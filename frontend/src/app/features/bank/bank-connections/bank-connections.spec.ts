import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { of } from 'rxjs';
import { TuiDialogService } from '@taiga-ui/core';
import { BankConnections } from './bank-connections';
import { ApiService } from '../../../core/api.service';
import { NotificationService } from '../../../core/notification.service';
import { bankRedirectUrl, type BankConnection, type BankCredentials } from '../../../models/bank';

const ok = <T>(data: T) => of({ data, error: null });

const DAY = 24 * 60 * 60 * 1000;

function connection(over: Partial<BankConnection> = {}): BankConnection {
  return {
    id: 1,
    aspspName: 'LHV',
    country: 'EE',
    status: 'active',
    validUntil: new Date(Date.now() + 60 * DAY).toISOString(),
    accounts: [{ uid: 'u1', iban: 'EE001', name: null, currency: 'EUR' }],
    ...over,
  };
}

async function render(credentials: BankCredentials, connections: BankConnection[] = [], confirm = true) {
  const api = {
    getBankCredentials: vi.fn(() => ok(credentials)),
    getBankConnections: vi.fn(() => ok(connections)),
    getBankAspsps: vi.fn(() => ok([{ name: 'LHV', country: 'EE', beta: false, maxConsentDays: 90 }])),
    startBankConnection: vi.fn(() => ok({ url: 'https://bank.example/auth' })),
    saveBankCredentials: vi.fn(),
    deleteBankCredentials: vi.fn(() => ok(null)),
    reconnectBank: vi.fn(),
    deleteBankConnection: vi.fn(),
  };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: ApiService, useValue: api },
      { provide: NotificationService, useValue: { showError: vi.fn(), showSuccess: vi.fn() } },
      { provide: TuiDialogService, useValue: { open: vi.fn(() => of(confirm)) } },
    ],
  });
  const fixture = TestBed.createComponent(BankConnections);
  await fixture.whenStable();
  fixture.detectChanges();
  return { fixture, api, el: fixture.nativeElement as HTMLElement };
}

describe('BankConnections', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('shows only the not-configured line when disabled', async () => {
    const { el, api } = await render({ enabled: false, applicationId: null, hasKey: false });
    expect(el.textContent).toContain('Bank sync is not configured on this server.');
    expect(el.querySelector('textarea')).toBeNull();
    expect(el.querySelector('button')).toBeNull();
    expect(api.getBankConnections).not.toHaveBeenCalled();
  });

  it('never pre-fills the private key and shows the loaded placeholder', async () => {
    const { el, fixture } = await render({ enabled: true, applicationId: 'app-1', hasKey: true });
    const textarea = el.querySelector('textarea')!;
    expect(textarea.value).toBe('');
    expect(textarea.placeholder).toBe('Key loaded — paste a new one to replace it');
    expect(fixture.componentInstance.form.controls.applicationId.value).toBe('app-1');
  });

  it('shows the callback address to register', async () => {
    const { el } = await render({ enabled: true, applicationId: null, hasKey: false });
    expect(el.textContent).toContain(bankRedirectUrl());
    expect(el.textContent).toContain('Activate by linking accounts');
  });

  it('starts a connection with the callback address', async () => {
    const { fixture, api } = await render({ enabled: true, applicationId: 'app-1', hasKey: true });
    const redirect = vi.spyOn(fixture.componentInstance, 'redirect').mockImplementation(() => undefined);
    fixture.componentInstance.connectForm.setValue({ country: 'EE', bank: 'LHV' });

    await fixture.componentInstance.connect();

    expect(api.startBankConnection).toHaveBeenCalledWith('LHV', 'EE');
    expect(redirect).toHaveBeenCalledWith('https://bank.example/auth');
  });

  it('asks before removing the key', async () => {
    const declined = await render({ enabled: true, applicationId: 'app-1', hasKey: true }, [], false);
    await declined.fixture.componentInstance.removeKey();
    expect(declined.api.deleteBankCredentials).not.toHaveBeenCalled();

    TestBed.resetTestingModule();
    const confirmed = await render({ enabled: true, applicationId: 'app-1', hasKey: true });
    await confirmed.fixture.componentInstance.removeKey();
    expect(confirmed.api.deleteBankCredentials).toHaveBeenCalled();
  });

  it('marks a connection expiring within 7 days', async () => {
    const soon = connection({ status: 'expiring', validUntil: new Date(Date.now() + 3 * DAY - 1000).toISOString() });
    const { el } = await render({ enabled: true, applicationId: 'app-1', hasKey: true }, [soon]);
    expect(el.textContent).toContain('Expires in 3 days');
    expect(el.textContent).toContain('EE001');
  });
});
