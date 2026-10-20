import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { of, Subject } from 'rxjs';
import { TuiDialogService } from '@taiga-ui/core';
import { POLYMORPHEUS_CONTEXT } from '@taiga-ui/polymorpheus';
import { AccountSharing } from './account-sharing';
import { AuthService } from '../../../core/auth.service';
import { AccountsState } from '../../../core/accounts.state';
import { CategoriesState } from '../../../core/categories.state';
import { TransactionsState } from '../../../core/transactions.state';
import type { AccountMember } from '../../../models/account';

const OWNER: AccountMember = { user_id: 1, name: 'Alice', email: 'alice@x', level: 4, is_creator: true };
const READER: AccountMember = { user_id: 2, name: 'Bob', email: 'bob@x', level: 1, is_creator: false };
const WRITER: AccountMember = { user_id: 2, name: 'Bob', email: 'bob@x', level: 2, is_creator: false };

function setup(myId: number, members: AccountMember[]) {
  const dialogOpen = vi.fn(() => of(true));
  const completeWith = vi.fn();
  const accounts = { reload: vi.fn() };
  const categories = { reload: vi.fn() };
  const transactions = { reload: vi.fn(), reloadWithout: vi.fn() };
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: POLYMORPHEUS_CONTEXT, useValue: { data: { id: 7, name: 'Wallet' }, completeWith } },
      { provide: TuiDialogService, useValue: { open: dialogOpen } },
      { provide: AuthService, useValue: { user: signal({ id: myId, email: '', name: '', currency: 'USD', currency_scale: 2 }) } },
      { provide: AccountsState, useValue: accounts },
      { provide: CategoriesState, useValue: categories },
      { provide: TransactionsState, useValue: transactions },
    ],
  });
  const fixture = TestBed.createComponent(AccountSharing);
  const http = TestBed.inject(HttpTestingController);
  http.expectOne('/api/accounts/7/shares').flush({ data: members, error: null });
  fixture.detectChanges();
  return { fixture, component: fixture.componentInstance, http, dialogOpen, completeWith, accounts, categories, transactions };
}

const flushAsync = () => new Promise(resolve => setTimeout(resolve));

describe('AccountSharing', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('renders members with level labels', () => {
    const { fixture } = setup(2, [OWNER, READER]);
    const text = fixture.nativeElement.textContent as string;
    expect(text).toContain('Alice');
    expect(text).toContain('Owner');
    expect(text).toContain('Read');
    expect(text).toContain('(you)');
  });

  it('hides management controls below co-owner', () => {
    const { fixture, component } = setup(2, [OWNER, WRITER]);
    const el = fixture.nativeElement as HTMLElement;
    expect(component.canManage()).toBe(false);
    const buttons = Array.from(el.querySelectorAll('button')).map(b => b.textContent?.trim());
    expect(buttons).not.toContain('Add');
    expect(el.querySelector('[data-test="remove"]')).toBeNull();
    expect(buttons).toContain('Leave account');
  });

  it('adds a member', async () => {
    const { component, http, accounts, categories, transactions } = setup(1, [OWNER]);
    component.form.setValue({ email: 'x@y', level: 2 });
    const done = component.add();
    await flushAsync();
    const req = http.expectOne('/api/accounts/7/shares');
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ email: 'x@y', level: 2 });
    const added: AccountMember = { user_id: 3, name: 'X', email: 'x@y', level: 2, is_creator: false };
    req.flush({ data: [OWNER, added], error: null });
    await done;
    expect(component.members()).toEqual([OWNER, added]);
    expect(accounts.reload).toHaveBeenCalled();
    expect(categories.reload).toHaveBeenCalled();
    expect(transactions.reload).toHaveBeenCalled();
  });

  it('accepts an email only when it is well-formed once trimmed', () => {
    const { component } = setup(1, [OWNER]);
    const email = component.form.controls.email;
    email.setValue('   ');
    expect(email.valid).toBe(false);
    email.setValue('bob');
    expect(email.valid).toBe(false);
    email.setValue(' bob@example.com ');
    expect(email.valid).toBe(true);
  });

  it('confirms before granting co-owner on a personal account', async () => {
    const { component, http, dialogOpen } = setup(1, [OWNER, READER]);
    const done = component.changeLevel(READER, 3);
    await flushAsync();
    expect(dialogOpen).toHaveBeenCalledTimes(1);
    const req = http.expectOne('/api/accounts/7/shares/2');
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual({ level: 3 });
    req.flush({ data: [{ ...OWNER, level: 3 }, { ...READER, level: 3 }], error: null });
    await done;
  });

  it('confirms before removing a member', async () => {
    const { component, http, dialogOpen } = setup(1, [OWNER, READER]);
    const done = component.remove(READER);
    await flushAsync();
    expect(dialogOpen).toHaveBeenCalledTimes(1);
    expect((dialogOpen.mock.calls[0] as unknown[])[1]).toMatchObject({
      data: { content: 'Remove Bob from "Wallet"? Their income and expenses on this account pass to the owner.' },
    });
    const req = http.expectOne('/api/accounts/7/shares/2');
    expect(req.request.method).toBe('DELETE');
    req.flush({ data: [OWNER], error: null });
    await done;
    expect(component.members()).toEqual([OWNER]);
  });

  it('does not remove a member when cancelled', async () => {
    const { component, http, dialogOpen } = setup(1, [OWNER, READER]);
    dialogOpen.mockReturnValue(of(false));
    await component.remove(READER);
    http.expectNone('/api/accounts/7/shares/2');
    expect(component.members()).toEqual([OWNER, READER]);
  });

  const CO_CREATOR: AccountMember = { ...OWNER, level: 3 };
  const CO_OWNER: AccountMember = { user_id: 2, name: '', email: 'bob@x', level: 3, is_creator: false };

  it("confirms before changing the creator's level", async () => {
    const { component, http, dialogOpen } = setup(2, [CO_CREATOR, CO_OWNER]);
    const done = component.changeLevel(CO_CREATOR, 1);
    await flushAsync();
    expect(dialogOpen).toHaveBeenCalledTimes(1);
    expect((dialogOpen.mock.calls[0] as unknown[])[1]).toMatchObject({
      data: { content: 'Alice created "Wallet". Changing their level makes you the owner.' },
    });
    const req = http.expectOne('/api/accounts/7/shares/1');
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual({ level: 1 });
    req.flush({ data: [{ ...CO_OWNER, level: 4, is_creator: true }, { ...OWNER, level: 1, is_creator: false }], error: null });
    await done;
  });

  it("keeps the creator's level when the change is cancelled", async () => {
    const { component, http, dialogOpen } = setup(2, [CO_CREATOR, CO_OWNER]);
    dialogOpen.mockReturnValue(of(false));
    const before = component.members();
    await component.changeLevel(CO_CREATOR, 1);
    http.expectNone('/api/accounts/7/shares/1');
    expect(component.members()).toEqual([CO_CREATOR, CO_OWNER]);
    // A fresh array re-renders the rows, putting the select back.
    expect(component.members()).not.toBe(before);
  });

  it('confirms before a co-owner lowers their own level', async () => {
    const { component, http, dialogOpen } = setup(2, [CO_CREATOR, CO_OWNER]);
    const done = component.changeLevel(CO_OWNER, 2);
    await flushAsync();
    expect((dialogOpen.mock.calls[0] as unknown[])[1]).toMatchObject({
      data: { content: 'Lower your own level on "Wallet" to Transactions? You will no longer be able to manage access.' },
    });
    http.expectOne('/api/accounts/7/shares/2').flush({ data: [CO_CREATOR, { ...CO_OWNER, level: 2 }], error: null });
    await done;
  });

  it('warns the creator that lowering their own level gives up ownership', async () => {
    const { component, http, dialogOpen } = setup(1, [CO_CREATOR, CO_OWNER]);
    const done = component.changeLevel(CO_CREATOR, 1);
    await flushAsync();
    expect((dialogOpen.mock.calls[0] as unknown[])[1]).toMatchObject({
      data: {
        content: 'Lower your own level on "Wallet" to Read? Ownership passes to another co-owner, and you will no longer be able to manage access.',
      },
    });
    http.expectOne('/api/accounts/7/shares/1').flush({ data: [{ ...CO_OWNER, level: 4, is_creator: true }, READER], error: null });
    await done;
  });

  it('keeps your own level when lowering it is cancelled', async () => {
    const { component, http, dialogOpen } = setup(2, [CO_CREATOR, CO_OWNER]);
    dialogOpen.mockReturnValue(of(false));
    await component.changeLevel(CO_OWNER, 1);
    http.expectNone('/api/accounts/7/shares/2');
    expect(component.members()).toEqual([CO_CREATOR, CO_OWNER]);
  });

  it('ignores a second change while a confirm is open', async () => {
    const { component, http, dialogOpen } = setup(1, [OWNER, READER]);
    const answer = new Subject<boolean>();
    dialogOpen.mockReturnValue(answer);
    const first = component.changeLevel(READER, 3);
    await flushAsync();
    expect(component.busy()).toBe(true);
    await component.remove(READER);
    expect(dialogOpen).toHaveBeenCalledTimes(1);
    answer.next(false);
    answer.complete();
    await first;
    expect(component.busy()).toBe(false);
    http.expectNone('/api/accounts/7/shares/2');
  });

  it('leaving closes the dialog', async () => {
    const { component, http, completeWith } = setup(2, [OWNER, READER]);
    const done = component.leave();
    await flushAsync();
    const req = http.expectOne('/api/accounts/7/shares/2');
    expect(req.request.method).toBe('DELETE');
    req.flush({ data: [OWNER], error: null });
    await done;
    expect(completeWith).toHaveBeenCalled();
  });

  it('leaving drops the account from the transaction filter', async () => {
    const { component, http, transactions } = setup(2, [OWNER, READER]);
    const done = component.leave();
    await flushAsync();
    http.expectOne('/api/accounts/7/shares/2').flush({ data: [OWNER], error: null });
    await done;
    expect(transactions.reloadWithout).toHaveBeenCalledWith(7);
    expect(transactions.reload).not.toHaveBeenCalled();
  });
});
