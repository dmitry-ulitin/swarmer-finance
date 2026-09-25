import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { of } from 'rxjs';
import { TuiDialogService } from '@taiga-ui/core';
import { POLYMORPHEUS_CONTEXT } from '@taiga-ui/polymorpheus';
import { AccountForm } from './account-form';
import { AccountsState } from '../../../core/accounts.state';
import type { Account } from '../../../models/account';

function createForm(data: Partial<Account> | null, dialogOpen = vi.fn(() => of(true))) {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: POLYMORPHEUS_CONTEXT, useValue: { data, completeWith: () => {} } },
      { provide: TuiDialogService, useValue: { open: dialogOpen } },
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

describe('AccountForm tracked wallet', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('locks start balance and currency once address and chain are set', () => {
    const form = createForm({ currency: 'USD' });
    form.form.patchValue({ name: 'Cold', currency: 'USD', startBalance: 5, type: 'crypto', address: 'bc1qxy2k', blockchain: 'bitcoin' });

    expect(form.tracked()).toBe(true);
    expect(form.form.controls.startBalance.disabled).toBe(true);
    expect(form.form.controls.currency.disabled).toBe(true);
    expect(form.buildPayload()).toMatchObject({ startBalance: 0, currency: 'BTC' });
  });

  it('unlocks when the address is cleared', () => {
    const form = createForm({ currency: 'USD' });
    form.form.patchValue({ type: 'crypto', address: 'bc1qxy2k', blockchain: 'bitcoin' });
    form.form.patchValue({ address: '' });

    expect(form.tracked()).toBe(false);
    expect(form.form.controls.startBalance.enabled).toBe(true);
    expect(form.form.controls.currency.enabled).toBe(true);
  });

  it('does not lock for an unsupported chain', () => {
    const form = createForm({ currency: 'ETH' });
    form.form.patchValue({ type: 'crypto', address: '0xabc', blockchain: 'ethereum' });

    expect(form.tracked()).toBe(false);
  });

  it('offers TRX and USDT for a tron wallet and keeps currency editable', () => {
    const form = createForm({ currency: 'USD' });
    form.form.patchValue({ name: 'Ledger', currency: 'EUR', startBalance: 5, type: 'crypto', address: 'TPJe9t', blockchain: 'tron' });

    expect(form.tracked()).toBe(true);
    expect(form.currencyOptions()).toEqual(['TRX', 'USDT']);
    expect(form.form.controls.currency.enabled).toBe(true);
    expect(form.form.controls.startBalance.disabled).toBe(true);
    expect(form.buildPayload()).toMatchObject({ startBalance: 0, currency: 'TRX' });
  });

  it('keeps an allowed currency when a tron wallet is set', () => {
    const form = createForm({ currency: 'USD' });
    form.form.patchValue({ currency: 'USDT', type: 'crypto', address: 'TPJe9t', blockchain: 'tron' });

    expect(form.buildPayload()).toMatchObject({ currency: 'USDT' });
  });

  it('offers the usual currencies again when tracking is off', () => {
    const form = createForm({ currency: 'USD' });
    form.form.patchValue({ type: 'crypto', address: 'TPJe9t', blockchain: 'tron' });
    form.form.patchValue({ address: '' });

    expect(form.currencyOptions()).not.toEqual(['TRX', 'USDT']);
  });
});

describe('AccountForm start balance precision', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('follows the chosen currency', () => {
    const form = createForm({ currency: 'EUR' });
    form.form.patchValue({ currency: 'EUR' });
    expect(form.balancePrecision()).toBe(2);
    form.form.patchValue({ currency: 'BTC' });
    expect(form.balancePrecision()).toBe(8);
  });
});

describe('AccountForm switching sync on', () => {
  beforeEach(() => TestBed.resetTestingModule());

  const plainWallet = {
    id: 7, name: 'Cold', currency: 'BTC', start_balance: 0, type: 'crypto', settings: {}, tracked: false,
  } as Partial<Account>;
  const spyUpdate = () => vi.spyOn(TestBed.inject(AccountsState), 'update')
    .mockReturnValue(of({ data: { ...plainWallet, tracked: true } as Account, error: null }));
  const track = (form: AccountForm) => form.form.patchValue({ name: 'Cold', address: 'bc1qcold', blockchain: 'bitcoin' });

  it('asks before switching sync on for an existing account, and saves on yes', async () => {
    const dialogOpen = vi.fn(() => of(true));
    const form = createForm(plainWallet, dialogOpen);
    const update = spyUpdate();
    track(form);
    await form.onSubmit();
    expect(dialogOpen).toHaveBeenCalledTimes(1);
    expect(update).toHaveBeenCalled();
  });

  it('sends nothing when the confirmation is cancelled', async () => {
    const form = createForm(plainWallet, vi.fn(() => of(false)));
    const update = spyUpdate();
    track(form);
    await form.onSubmit();
    expect(update).not.toHaveBeenCalled();
  });

  it('does not ask when a tracked account is saved again', async () => {
    const dialogOpen = vi.fn(() => of(true));
    const form = createForm({ ...plainWallet, tracked: true, settings: { address: 'bc1qcold', blockchain: 'bitcoin' } } as Partial<Account>, dialogOpen);
    spyUpdate();
    await form.onSubmit();
    expect(dialogOpen).not.toHaveBeenCalled();
  });

  it('does not ask when creating a tracked account', async () => {
    const dialogOpen = vi.fn(() => of(true));
    const form = createForm({ currency: 'BTC' }, dialogOpen);
    vi.spyOn(TestBed.inject(AccountsState), 'create').mockReturnValue(of({ data: plainWallet as Account, error: null }));
    form.form.patchValue({ type: 'crypto' });
    track(form);
    await form.onSubmit();
    expect(dialogOpen).not.toHaveBeenCalled();
  });
});
