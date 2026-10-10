import { describe, it, expect, beforeEach } from 'vitest';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { POLYMORPHEUS_CONTEXT } from '@taiga-ui/polymorpheus';
import { TransactionForm } from './transaction-form';
import { CategoriesState } from '../../../core/categories.state';
import { AccountsState } from '../../../core/accounts.state';
import { TransactionsState } from '../../../core/transactions.state';
import { AuthService } from '../../../core/auth.service';
import { NotificationService } from '../../../core/notification.service';
import type { Category } from '../../../models/category';
import type { Transaction } from '../../../models/transaction';
import type { Account } from '../../../models/account';
import { TuiDay } from '@taiga-ui/cdk/date-time';

const ME = 1;
const OTHER = 2;

function makeCategory(overrides: Partial<Category> & Pick<Category, 'id' | 'name'>): Category {
  return {
    user_id: ME,
    parent_id: 2,
    color: '#111111',
    icon: 'tag',
    created_at: '',
    owner_name: null,
    fullName: overrides.name,
    root_id: 2,
    ...overrides,
  };
}

// My own expense category, and one owned by someone I share an account with.
const myCategory = makeCategory({ id: 10, name: 'Groceries' });
const foreignCategory = makeCategory({
  id: 20,
  name: 'Their Groceries',
  user_id: OTHER,
  owner_name: 'Other User',
});

const uncategorizedExpense = makeCategory({ id: 4, name: 'Uncategorized', user_id: null });

const tree: Category[] = [
  makeCategory({ id: 1, name: 'Income', user_id: null, parent_id: null, root_id: 1, children: [] }),
  makeCategory({
    id: 2,
    name: 'Expenses',
    user_id: null,
    parent_id: null,
    children: [uncategorizedExpense, myCategory, foreignCategory],
  }),
];

function configure(
  data: Partial<Transaction>,
  accounts: Partial<Account>[] = [],
  trackedIds: number[] = []
) {
  TestBed.configureTestingModule({
    providers: [
      TransactionForm,
      { provide: POLYMORPHEUS_CONTEXT, useValue: { data, completeWith: () => {} } },
      { provide: CategoriesState, useValue: { categories: signal(tree) } },
      {
        provide: AccountsState,
        useValue: {
          accounts: signal(accounts),
          trackedIds: signal(new Set(trackedIds)),
          transferTargets: signal(accounts.filter(a => !trackedIds.includes(a.id!) && !a.deleted)),
        },
      },
      { provide: TransactionsState, useValue: { transactions: signal([]) } },
      { provide: AuthService, useValue: { user: signal({ id: ME }) } },
      { provide: NotificationService, useValue: { showError: () => {} } },
    ],
  });
  return TestBed.inject(TransactionForm);
}

describe('TransactionForm category initialisation', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it("keeps another user's category instead of falling back to the first one", () => {
    // A transaction on a shared account, entered by someone else: its
    // category is not in this user's own branch of the tree.
    const form = configure({
      debit_account: { id: 1, name: 'Shared', currency: 'USD', scale: 2 },
      category: foreignCategory,
    });

    expect(form.form.controls.category.value?.id).toBe(foreignCategory.id);
    expect(form.form.controls.category.value?.name).toBe('Their Groceries');
  });

  it('keeps a category the loaded tree does not contain at all', () => {
    // The tree can lag behind — it is loaded once per session, so a
    // category created after that load is missing from it. Resolving the
    // control's value by looking the id up in the tree silently dropped
    // such a category and reset the field to the first visible one.
    const missing = makeCategory({
      id: 99,
      name: 'Not In Tree',
      user_id: OTHER,
      owner_name: 'Other User',
    });

    const form = configure({
      debit_account: { id: 1, name: 'Shared', currency: 'USD', scale: 2 },
      category: missing,
    });

    expect(form.form.controls.category.value?.id).toBe(99);
    expect(form.form.controls.category.value?.name).toBe('Not In Tree');
  });

  it("uses the transaction's own category when it belongs to this user", () => {
    const form = configure({
      debit_account: { id: 1, name: 'Mine', currency: 'USD', scale: 2 },
      category: myCategory,
    });

    expect(form.form.controls.category.value?.id).toBe(myCategory.id);
  });

  it('falls back to Uncategorized for a new transaction', () => {
    const form = configure({
      debit_account: { id: 1, name: 'Mine', currency: 'USD', scale: 2 },
    });

    expect(form.form.controls.category.value?.id).toBe(uncategorizedExpense.id);
  });

  // Path-matching, foreign-category flagging and the tree rendering moved to
  // CategorySelect and are covered by its own spec. What stays here is the
  // form's own responsibility: choosing which branch the picker offers.
  it('offers the expense branch for an expense', () => {
    const form = configure({ debit_account: { id: 1, name: 'Mine', currency: 'USD', scale: 2 } });

    expect(form.categoryRootId()).toBe(2);
  });

  it('offers the income branch for an income', () => {
    const form = configure({ credit_account: { id: 1, name: 'Mine', currency: 'USD', scale: 2 } });

    expect(form.categoryRootId()).toBe(1);
  });
});

describe('TransactionForm on a synced account', () => {
  beforeEach(() => TestBed.resetTestingModule());

  const wallet = { id: 1, name: 'Cold', currency: 'BTC', scale: 8 };
  const exchange = { id: 3, name: 'Exchange', currency: 'BTC', scale: 8 };

  it('locks what the chain states and leaves the rest editable', () => {
    const form = configure(
      { id: 5, debit_account: wallet, debit: 0.001, credit: 0.001, date: '2026-05-29', payee: 'bc1qshop', category: myCategory },
      [wallet, exchange],
      [1]
    );
    const c = form.form.controls;

    expect(c.date.disabled).toBe(true);
    expect(c.payee.disabled).toBe(true);
    expect(c.fromAccount.disabled).toBe(true);
    expect(c.debitAmount.disabled).toBe(true);
    expect(c.category.enabled).toBe(true);
    expect(c.description.enabled).toBe(true);
    expect(c.toAccount.enabled).toBe(true);
    expect([form.typeAllowed(0), form.typeAllowed(1), form.typeAllowed(2)]).toEqual([true, false, true]);
  });

  it('locks the category and type of a network fee', () => {
    const fees = makeCategory({ id: 5, name: 'Network fees', user_id: null });
    const form = configure({ id: 7, debit_account: wallet, debit: 0.0001, credit: 0.0001, category: fees }, [wallet], [1]);
    expect(form.form.controls.category.disabled).toBe(true);
    expect(form.form.getRawValue().category?.id).toBe(5);
    expect([form.typeAllowed(0), form.typeAllowed(1), form.typeAllowed(2)]).toEqual([true, false, false]);
  });

  it('never pre-picks a synced account as the other side of a transfer', () => {
    const form = configure({ credit_account: exchange }, [wallet, exchange], [1]);
    form.activeTypeIndex.set(2);
    TestBed.tick();
    expect(form.form.controls.fromAccount.value).toBeNull();
  });

  it('allows no type change on a transfer between synced wallets', () => {
    const other = { id: 2, name: 'Hot', currency: 'BTC', scale: 8 };
    const form = configure({ id: 6, debit_account: wallet, credit_account: other }, [wallet, other], [1, 2]);
    expect([form.typeAllowed(0), form.typeAllowed(1), form.typeAllowed(2)]).toEqual([false, false, false]);
  });
});

describe('TransactionForm txid', () => {
  beforeEach(() => TestBed.resetTestingModule());

  const BTC_TX = 'a'.repeat(64);
  const crypto = (id: number, blockchain: string) =>
    ({ id, name: `W${id}`, currency: 'X', scale: 8, type: 'crypto', settings: { address: 'addr', blockchain } }) as Partial<Account>;
  const ref = (id: number) => ({ id, name: `W${id}`, currency: 'X', scale: 8 });

  it.each([
    ['bitcoin', BTC_TX, `https://mempool.space/tx/${BTC_TX}`],
    ['tron', BTC_TX, `https://tronscan.org/#/transaction/${BTC_TX}`],
    ['ethereum', `0x${BTC_TX}`, `https://etherscan.io/tx/0x${BTC_TX}`],
  ])('links a %s txid to its explorer', (blockchain, txid, url) => {
    const form = configure({ id: 5, debit_account: ref(1), txid }, [crypto(1, blockchain)], [1]);
    expect(form.chainTx()).toEqual({ txid, short: `${txid.slice(0, 10)}…${txid.slice(-8)}`, url });
  });

  it('takes the chain from the synced side of a transfer', () => {
    const exchange = { id: 3, name: 'Exchange', currency: 'X', scale: 8, type: 'crypto', settings: {} } as Partial<Account>;
    const form = configure(
      { id: 5, debit_account: ref(3), credit_account: ref(1), txid: BTC_TX }, [exchange, crypto(1, 'tron')], [1]
    );
    expect(form.chainTx()?.url).toBe(`https://tronscan.org/#/transaction/${BTC_TX}`);
  });

  it('shows the txid without a link when the account is not loaded', () => {
    const form = configure({ id: 5, debit_account: ref(1), txid: BTC_TX }, [], [1]);
    expect(form.chainTx()).toMatchObject({ txid: BTC_TX, url: null });
  });

  it('shows nothing for a synced row without a txid', () => {
    expect(configure({ id: 5, debit_account: ref(1), txid: null }, [crypto(1, 'bitcoin')], [1]).chainTx()).toBeNull();
  });

  it('shows nothing for a new transaction', () => {
    expect(configure({}, [], []).chainTx()).toBeNull();
  });
});

describe('TransactionForm payee', () => {
  beforeEach(() => TestBed.resetTestingModule());

  const ADDR = 'T' + 'b'.repeat(33);
  const crypto = (id: number, blockchain: string) =>
    ({ id, name: `W${id}`, currency: 'X', scale: 8, type: 'crypto', settings: { address: 'addr', blockchain } }) as Partial<Account>;
  const ref = (id: number) => ({ id, name: `W${id}`, currency: 'X', scale: 8 });

  it.each([
    ['bitcoin', `https://mempool.space/address/${ADDR}`],
    ['tron', `https://tronscan.org/#/address/${ADDR}`],
    ['ethereum', `https://etherscan.io/address/${ADDR}`],
  ])('links a synced %s payee to its explorer', (blockchain, url) => {
    const form = configure({ id: 5, credit_account: ref(1), payee: ADDR }, [crypto(1, blockchain)], [1]);
    expect(form.chainPayee()).toEqual({ value: ADDR, short: `${ADDR.slice(0, 10)}…${ADDR.slice(-8)}`, url });
  });

  it('keeps a short payee whole and unlinked when the account is not loaded', () => {
    const form = configure({ id: 5, debit_account: ref(1), payee: 'Shop' }, [], [1]);
    expect(form.chainPayee()).toEqual({ value: 'Shop', short: 'Shop', url: null });
  });

  it('shows nothing for a synced row without a payee', () => {
    expect(configure({ id: 5, debit_account: ref(1), payee: null }, [crypto(1, 'tron')], [1]).chainPayee()).toBeNull();
  });

  it('leaves the payee editable on an unsynced row', () => {
    const form = configure({ id: 5, debit_account: ref(1), payee: ADDR }, [], []);
    expect(form.chainPayee()).toBeNull();
    expect(form.form.controls.payee.enabled).toBe(true);
  });
});

describe('TransactionForm date buttons', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('steps the date back and forward a day, across a month boundary', () => {
    const form = configure({ date: '2026-03-01' });
    form.shiftDate(-1);
    expect(form.form.controls.date.value?.toJSON()).toBe('2026-02-28');
    form.shiftDate(1);
    form.shiftDate(1);
    expect(form.form.controls.date.value?.toJSON()).toBe('2026-03-02');
  });

  it('sets today, and steps from today when the date is empty', () => {
    const form = configure({ date: '2020-01-01' });
    form.setToday();
    expect(form.form.controls.date.value?.toJSON()).toBe(TuiDay.currentLocal().toJSON());
    form.form.controls.date.setValue(null);
    form.shiftDate(1);
    expect(form.form.controls.date.value?.toJSON()).toBe(TuiDay.currentLocal().append({ day: 1 }).toJSON());
  });
});

describe('TransactionForm amount precision', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it("shows each side's amount at its account's scale", () => {
    const btc = { id: 1, name: 'Cold', currency: 'BTC', scale: 8 };
    const eur = { id: 2, name: 'Bank', currency: 'EUR', scale: 2 };
    const form = configure({ debit_account: btc, credit_account: eur, debit: 0.00146435, credit: 90 }, [btc, eur]);
    expect(form.debitPrecision()).toBe(8);
    expect(form.creditPrecision()).toBe(2);
  });
});

describe('TransactionForm transfer accounts', () => {
  beforeEach(() => TestBed.resetTestingModule());

  const a = { id: 11, name: 'A', currency: 'EUR', scale: 2 };
  const b = { id: 12, name: 'B', currency: 'EUR', scale: 2 };
  const c = { id: 13, name: 'C', currency: 'EUR', scale: 2 };
  const transfer = () => configure({ debit_account: a, credit_account: b }, [a, b, c]);

  it('swaps the sides when From is set to the To account', () => {
    const form = transfer();
    form.form.controls.fromAccount.setValue(b);
    expect(form.form.controls.toAccount.value).toEqual(a);
  });

  it('swaps the sides when To is set to the From account', () => {
    const form = transfer();
    form.form.controls.toAccount.setValue(a);
    expect(form.form.controls.fromAccount.value).toEqual(b);
  });

  it('leaves the other side alone for a different account', () => {
    const form = transfer();
    form.form.controls.fromAccount.setValue(c);
    expect(form.form.controls.toAccount.value).toEqual(b);
  });
});
