import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { POLYMORPHEUS_CONTEXT } from '@taiga-ui/polymorpheus';
import { AccountForm } from './account-form';
import type { Account } from '../../../models/account';

function createForm(data: Partial<Account> | null) {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: POLYMORPHEUS_CONTEXT, useValue: { data, completeWith: () => {} } },
    ],
  });
  return TestBed.createComponent(AccountForm).componentInstance;
}

describe('AccountForm payload', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('defaults to a cash account with empty settings', () => {
    const form = createForm({ currency: 'USD' });
    form.form.patchValue({ name: 'Wallet', currency: 'USD', startBalance: 0 });

    expect(form.buildPayload()).toEqual({
      name: 'Wallet', currency: 'USD', startBalance: 0,
      type: 'cash', settings: {},
    });
  });

  it('sends only crypto keys for a crypto account', () => {
    const form = createForm({ currency: 'BTC' });
    form.form.patchValue({
      name: 'Ledger', currency: 'BTC', startBalance: 0,
      type: 'crypto', address: 'bc1qxy2k', blockchain: 'bitcoin',
    });

    expect(form.buildPayload()).toEqual({
      name: 'Ledger', currency: 'BTC', startBalance: 0,
      type: 'crypto', settings: { address: 'bc1qxy2k', blockchain: 'bitcoin' },
    });
  });

  it('omits blank optional fields instead of sending empty strings', () => {
    const form = createForm({ currency: 'USD' });
    form.form.patchValue({
      name: 'Checking', currency: 'USD', startBalance: 0,
      type: 'bank', accountNumber: '   ',
    });

    expect(form.buildPayload()).toEqual({
      name: 'Checking', currency: 'USD', startBalance: 0,
      type: 'bank', settings: {},
    });
  });

  it('drops the other type\'s fields when the type changes', () => {
    const form = createForm({ currency: 'USD' });
    form.form.patchValue({
      name: 'Switcher', currency: 'USD', startBalance: 0,
      type: 'bank', accountNumber: '111',
    });
    form.form.patchValue({ type: 'crypto', address: '0xabc' });

    const payload = form.buildPayload();
    expect(payload.settings).toEqual({ address: '0xabc' });
    expect(payload.settings).not.toHaveProperty('accountNumber');
  });

  it('populates type-specific controls when editing', () => {
    const form = createForm({
      id: 7, name: 'Checking', currency: 'USD', startBalance: 0,
      type: 'bank', settings: { accountNumber: 'DE89' },
    } as Partial<Account>);

    expect(form.form.getRawValue().type).toBe('bank');
    expect(form.form.getRawValue().accountNumber).toBe('DE89');
  });
});
