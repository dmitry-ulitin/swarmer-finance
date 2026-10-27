import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { of } from 'rxjs';
import { POLYMORPHEUS_CONTEXT } from '@taiga-ui/polymorpheus';
import { BankLink } from './bank-link';
import { ApiService } from '../../../core/api.service';
import { AccountsState } from '../../../core/accounts.state';
import { NotificationService } from '../../../core/notification.service';
import type { BankConnection } from '../../../models/bank';

const ok = <T>(data: T) => of({ data, error: null });

const connections: BankConnection[] = [{
  id: 7, aspspName: 'LHV', country: 'EE', status: 'active', validUntil: null,
  accounts: [
    { uid: 'eur', iban: 'EE1', name: 'Main', currency: 'EUR' },
    { uid: 'usd', iban: 'EE2', name: null, currency: 'USD' },
    { uid: 'multi', iban: null, name: 'Multi', currency: 'XXX' },
  ],
}];

async function render(bank_link: unknown = null) {
  const api = {
    getBankConnections: vi.fn(() => ok(connections)),
    linkBankAccount: vi.fn(() => ok({})),
    unlinkBankAccount: vi.fn(() => ok({ success: true })),
  };
  const completeWith = vi.fn();
  const accounts = { reload: vi.fn() };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      { provide: ApiService, useValue: api },
      { provide: AccountsState, useValue: accounts },
      { provide: NotificationService, useValue: { showError: vi.fn(), showSuccess: vi.fn() } },
      { provide: POLYMORPHEUS_CONTEXT, useValue: { data: { id: 3, currency: 'EUR', bank_link }, completeWith } },
    ],
  });
  const fixture = TestBed.createComponent(BankLink);
  await fixture.whenStable();
  fixture.detectChanges();
  return { cmp: fixture.componentInstance, api, completeWith, accounts };
}

describe('BankLink', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('disables accounts in another currency, keeps XXX selectable', async () => {
    const { cmp } = await render();
    const byUid = Object.fromEntries(cmp.options().map(o => [o.uid, o.disabled]));
    expect(byUid).toEqual({ eur: false, usd: true, multi: false });
    expect(cmp.options().find(o => o.uid === 'multi')!.label).toBe('LHV · Multi · multi-currency');
  });

  it('saves the chosen link and reloads accounts', async () => {
    const { cmp, api, completeWith, accounts } = await render();
    cmp.control.setValue(cmp.options().find(o => o.uid === 'eur')!.label);
    await cmp.save();
    expect(api.linkBankAccount).toHaveBeenCalledWith(3, 7, 'eur');
    expect(accounts.reload).toHaveBeenCalled();
    expect(completeWith).toHaveBeenCalledWith(true);
  });

  it('preselects the current link and unlinks it', async () => {
    const { cmp, api, completeWith } = await render({ connectionId: 7, uid: 'eur' });
    expect(cmp.control.value).toBe('LHV · Main · EUR');
    await cmp.unlink();
    expect(api.unlinkBankAccount).toHaveBeenCalledWith(3);
    expect(completeWith).toHaveBeenCalledWith(true);
  });
});
