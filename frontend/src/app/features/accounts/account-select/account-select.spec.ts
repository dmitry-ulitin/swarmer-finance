import { describe, it, expect, beforeEach, onTestFinished, vi } from 'vitest';
import { ChangeDetectionStrategy, Component, signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideTaiga, TuiRoot } from '@taiga-ui/core';
import { AccountSelect } from './account-select';
import { AccountsState } from '../../../core/accounts.state';
import { AuthService } from '../../../core/auth.service';
import type { Account } from '../../../models/account';

function makeAccount(id: number, name: string, currency = 'EUR'): Account {
  return {
    id, user_id: 1, name, currency, scale: 2, start_balance: 0, balance: 0,
    user_balance: 0, deleted: false, created_at: '', type: 'bank', settings: {},
  };
}

const lhv = makeAccount(1, 'LHV');
const cash = makeAccount(2, 'Cash');
const usd = makeAccount(3, 'Wise USD', 'USD');
const shared: Account = { ...makeAccount(4, 'Joint', 'EUR'), user_id: 2, owner_name: 'Kate', access_level: 3 };
const me = { provide: AuthService, useValue: { user: signal({ id: 1 }) } };

function setup(excludeId: number | null = null) {
  TestBed.configureTestingModule({
    providers: [
      me,
      {
        provide: AccountsState,
        useValue: { accounts: signal([lhv, cash, usd, shared]), transferTargets: signal([lhv, cash, usd]) },
      },
    ],
  });
  const fixture = TestBed.createComponent(AccountSelect);
  fixture.componentRef.setInput('excludeId', excludeId);
  fixture.detectChanges();
  return fixture.componentInstance;
}

// The dropdown is a portal, which needs tui-root to render into.
@Component({
  imports: [TuiRoot, AccountSelect],
  template: `<tui-root><app-account-select [excludeId]="1" /></tui-root>`,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
class RootHost {}

describe('AccountSelect', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('offers every transfer target', () => {
    expect(setup().options().map(a => a.name)).toEqual(['Cash', 'LHV', 'Wise USD']);
  });

  it('orders by access level, own accounts first, then by name ignoring case', () => {
    const readOnlyA: Account = { ...makeAccount(5, 'Alpha'), access_level: 2 };
    const admin: Account = { ...makeAccount(6, 'beta'), access_level: 3 };
    const ownLower = makeAccount(7, 'alpha');
    TestBed.configureTestingModule({
      providers: [
        me,
        {
          provide: AccountsState,
          useValue: { accounts: signal([]), transferTargets: signal([readOnlyA, usd, admin, ownLower, cash]) },
        },
      ],
    });
    const fixture = TestBed.createComponent(AccountSelect);
    fixture.detectChanges();
    expect(fixture.componentInstance.options().map(a => a.id)).toEqual([7, 2, 3, 6, 5]);
  });

  it('leaves out the excluded account', () => {
    expect(setup(1).options().map(a => a.name)).toEqual(['Cash', 'Wise USD']);
  });

  it('marks only accounts owned by someone else as foreign', () => {
    const select = setup();
    expect(select.isForeign(cash)).toBe(false);
    expect(select.isForeign(shared)).toBe(true);
  });

  it('matches accounts by id', () => {
    const select = setup();
    expect(select.accountMatcher(cash, { ...cash })).toBe(true);
    expect(select.accountMatcher(cash, lhv)).toBe(false);
  });

  it('shows a bare transaction account as the full account it refers to', () => {
    const select = setup();
    select.writeValue({ id: 4, name: 'Joint', currency: 'EUR', scale: 2 });
    expect(select.displayed()).toBe(shared);
  });

  it('shows a value it cannot resolve as given', () => {
    const select = setup();
    const unknown = { id: 99, name: 'Gone', currency: 'EUR', scale: 2 };
    select.writeValue(unknown);
    expect(select.displayed()).toBe(unknown);
  });

  it('reports a picked account to the form', () => {
    const select = setup();
    const onChange = vi.fn();
    select.registerOnChange(onChange);

    select['onValueChange'](cash);

    expect(onChange).toHaveBeenCalledWith(cash);
  });

  it('lists name, owner of a shared account, and currency in the open dropdown', async () => {
    // jsdom has no matchMedia, which tui-root reads.
    vi.stubGlobal('matchMedia', () => ({
      matches: false, addEventListener() {}, removeEventListener() {},
    }));
    onTestFinished(() => { vi.unstubAllGlobals(); });
    TestBed.configureTestingModule({
      providers: [
        provideTaiga(),
        me,
        {
          provide: AccountsState,
          useValue: { accounts: signal([lhv, cash, usd, shared]), transferTargets: signal([lhv, cash, usd, shared]) },
        },
      ],
    });
    const fixture = TestBed.createComponent(RootHost);
    await fixture.whenStable();
    (fixture.nativeElement as HTMLElement).querySelector('input')!.click();
    await fixture.whenStable();
    const options = [...document.querySelectorAll('tui-data-list button')];
    const parts = options.map(o =>
      [...o.querySelectorAll('.name, .owner, .currency')].map(e => e.textContent?.trim())
    );
    expect(parts).toEqual([['Cash', 'EUR'], ['Wise USD', 'USD'], ['Joint', 'Kate', 'EUR']]);
  });
});
