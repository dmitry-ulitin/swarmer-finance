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
import { ApiService } from '../../../core/api.service';
import type { Account } from '../../../models/account';
import type { BankConnection, BankLink } from '../../../models/bank';

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
      name: 'Wallet', currency: 'USD', startBalance: 0, inNetWorth: true,
      type: 'cash', settings: {},
    });
  });

  it('takes the net worth flag from the account and sends it back', () => {
    const form = createForm({ id: 1, name: 'Old', currency: 'USD', type: 'cash', in_net_worth: false });
    expect(form.form.controls.inNetWorth.value).toBe(false);
    form.form.patchValue({ inNetWorth: true });
    expect(form.buildPayload().inNetWorth).toBe(true);
  });

  it('offers the valued account types', () => {
    const form = createForm({ currency: 'USD' });
    expect(form.accountTypes).toEqual(expect.arrayContaining(['investment', 'property', 'deposit']));
    expect(form.typeLabel('investment')).toBe('Investment');
  });

  it.each(['investment', 'property', 'deposit'] as const)('sends empty settings for a %s account', type => {
    const form = createForm({ currency: 'USD' });
    form.form.patchValue({ name: 'X', currency: 'USD', startBalance: 0, type });

    expect(form.buildPayload()).toEqual({ name: 'X', currency: 'USD', startBalance: 0, inNetWorth: true, type, settings: {} });
  });

  it('sends a typed currency trimmed and upper-cased', () => {
    const form = createForm({ currency: 'USD' });
    form.form.patchValue({ name: 'Wallet', currency: ' usdt ', startBalance: 0 });

    expect(form.buildPayload().currency).toBe('USDT');
    expect(form.balancePrecision()).toBe(6);
  });

  it('sends only crypto keys for a crypto account', () => {
    const form = createForm({ currency: 'BTC' });
    form.form.patchValue({
      name: 'Ledger', currency: 'BTC', startBalance: 0,
      type: 'crypto', address: 'bc1qxy2k', blockchain: 'bitcoin',
    });

    expect(form.buildPayload()).toEqual({
      name: 'Ledger', currency: 'BTC', startBalance: 0, inNetWorth: true,
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
      name: 'Checking', currency: 'USD', startBalance: 0, inNetWorth: true,
      type: 'bank', settings: {}, bankLink: null,
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
    const form = createForm({ currency: 'SOL' });
    form.form.patchValue({ type: 'crypto', address: 'So1abc', blockchain: 'solana' });

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

  it('offers ETH and USDT for an ethereum wallet and keeps currency editable', () => {
    const form = createForm({ currency: 'USD' });
    form.form.patchValue({ name: 'MetaMask', currency: 'EUR', startBalance: 5, type: 'crypto', address: '0xF4f8', blockchain: 'ethereum' });

    expect(form.tracked()).toBe(true);
    expect(form.blockchains).toContain('ethereum');
    expect(form.currencyOptions()).toEqual(['ETH', 'USDT']);
    expect(form.form.controls.currency.enabled).toBe(true);
    expect(form.buildPayload()).toMatchObject({ startBalance: 0, currency: 'ETH' });
  });

  it('locks the currency of an already-tracked wallet while its address and chain stay', () => {
    const form = createForm({
      currency: 'USDT', type: 'crypto', tracked: true, settings: { address: 'TPJe9t', blockchain: 'tron' },
    } as Partial<Account>);

    expect(form.form.controls.currency.disabled).toBe(true);
    expect(form.buildPayload()).toMatchObject({ currency: 'USDT' });

    form.form.patchValue({ address: 'TOther' });
    expect(form.form.controls.currency.enabled).toBe(true);
  });

  it('offers the usual currencies again when tracking is off', () => {
    const form = createForm({ currency: 'USD' });
    form.form.patchValue({ type: 'crypto', address: 'TPJe9t', blockchain: 'tron' });
    form.form.patchValue({ address: '' });

    expect(form.currencyOptions()).not.toEqual(['TRX', 'USDT']);
  });
});

describe('AccountForm start balance with transactions', () => {
  beforeEach(() => TestBed.resetTestingModule());

  const withTransactions = { id: 7, currency: 'USD', type: 'cash', settings: {}, start_balance: 50, last_transaction_date: '2026-02-01' } as Partial<Account>;

  it('locks the start balance of an account that has transactions', () => {
    const form = createForm(withTransactions);

    expect(form.hasTransactions).toBe(true);
    expect(form.form.controls.startBalance.disabled).toBe(true);
    expect(form.buildPayload()).toMatchObject({ startBalance: 50 });
  });

  it('keeps it locked, at the stored value, when sync is switched off again', () => {
    const form = createForm(withTransactions);
    form.form.patchValue({ type: 'crypto', address: 'bc1qxy2k', blockchain: 'bitcoin' });
    form.form.patchValue({ address: '' });

    expect(form.form.controls.startBalance.disabled).toBe(true);
    expect(form.buildPayload()).toMatchObject({ startBalance: 50 });
  });

  it('leaves the start balance editable without transactions', () => {
    const form = createForm({ ...withTransactions, last_transaction_date: null });

    expect(form.hasTransactions).toBe(false);
    expect(form.form.controls.startBalance.enabled).toBe(true);
  });
});

describe('AccountForm leaving a tracked wallet', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('restores the start balance and currency the lock replaced', () => {
    const form = createForm({ id: 7, name: 'Savings', currency: 'EUR', type: 'cash', settings: {}, start_balance: 100 } as Partial<Account>);
    form.form.patchValue({ type: 'crypto', address: 'bc1qxy2k', blockchain: 'bitcoin' });
    expect(form.buildPayload()).toMatchObject({ startBalance: 0, currency: 'BTC' });

    form.form.patchValue({ blockchain: '' });
    expect(form.form.controls.startBalance.enabled).toBe(true);
    expect(form.buildPayload()).toMatchObject({ startBalance: 100, currency: 'EUR' });
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

describe('AccountForm bank link', () => {
  beforeEach(() => TestBed.resetTestingModule());

  const connections: BankConnection[] = [{
    id: 4, aspspName: 'LHV', country: 'EE', status: 'active', validUntil: null,
    accounts: [
      { uid: 'multi', iban: 'EE01', name: 'Main', currency: 'XXX' },
      { uid: 'usd', iban: 'EE02', name: null, currency: 'USD' },
    ],
  }];
  const link = (over: Partial<BankLink> = {}): BankLink => ({
    connectionId: 9, uid: 'other', aspspName: 'Swedbank', accountName: 'Joint', iban: null, currency: 'EUR',
    status: 'active', validUntil: null, loadedTo: null, ownConnection: false, ...over,
  });

  async function bankForm(data: Partial<Account>) {
    TestBed.configureTestingModule({
      providers: [
        provideZonelessChangeDetection(),
        { provide: ApiService, useValue: { getBankConnections: vi.fn(() => of({ data: connections, error: null })) } },
        { provide: AccountsState, useValue: { currencies: () => ['EUR', 'USD'] } },
        { provide: POLYMORPHEUS_CONTEXT, useValue: { data, completeWith: () => {} } },
        { provide: TuiDialogService, useValue: { open: vi.fn() } },
      ],
    });
    const form = TestBed.createComponent(AccountForm).componentInstance;
    // The connections load in the constructor; let that promise settle.
    await Promise.resolve();
    return form;
  }

  it('offers the connections\' bank accounts and disables other currencies', async () => {
    const form = await bankForm({ currency: 'EUR', type: 'bank' });
    form.form.patchValue({ name: 'LHV EUR', currency: 'EUR', type: 'bank' });
    expect(form.bankOptions().map(o => o.label)).toEqual([
      'Not linked', 'LHV · Main · multi-currency', 'LHV · EE02 · USD',
    ]);
    expect(form.fitsBank('4:multi')).toBe(true);
    expect(form.fitsBank('4:usd')).toBe(false);
  });

  it('sends the chosen bank account on create', async () => {
    const form = await bankForm({ currency: 'EUR' });
    form.form.patchValue({ name: 'LHV EUR', currency: 'EUR', type: 'bank', bankAccount: '4:multi' });
    expect(form.buildPayload().bankLink).toEqual({ connectionId: 4, uid: 'multi' });
  });

  it('flags a bank account in another currency', async () => {
    const form = await bankForm({ currency: 'EUR' });
    form.form.patchValue({ name: 'LHV', currency: 'EUR', type: 'bank', bankAccount: '4:usd' });
    expect(form.bankMismatch()).toBe(true);
    form.form.patchValue({ currency: 'USD' });
    expect(form.bankMismatch()).toBe(false);
  });

  it("keeps a link through another member's connection", async () => {
    const form = await bankForm({ id: 3, name: 'Joint', currency: 'EUR', type: 'bank', settings: {}, bank_link: link() });
    expect(form.bankLabelOf(form.form.controls.bankAccount.value)).toBe('Swedbank · Joint · EUR');
    expect(form.buildPayload().bankLink).toEqual({ connectionId: 9, uid: 'other' });
  });

  it('unlinks when the account stops being a bank account', async () => {
    const form = await bankForm({ id: 3, name: 'Joint', currency: 'EUR', type: 'bank', settings: {}, bank_link: link() });
    form.form.patchValue({ type: 'cash' });
    expect(form.buildPayload().bankLink).toBeNull();
  });
});
