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
import { NotificationService } from '../../../core/notification.service';
import type { AccountMember } from '../../../models/account';

const OWNER: AccountMember = { user_id: 1, name: 'Alice', email: 'alice@x', level: 4, is_creator: true };
const READER: AccountMember = { user_id: 2, name: 'Bob', email: 'bob@x', level: 1, is_creator: false };
const WRITER: AccountMember = { user_id: 2, name: 'Bob', email: 'bob@x', level: 2, is_creator: false };

/** `members: null` fails the initial load. */
function setup(myId: number, members: AccountMember[] | null) {
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
      { provide: NotificationService, useValue: { showError: vi.fn() } },
    ],
  });
  const fixture = TestBed.createComponent(AccountSharing);
  const http = TestBed.inject(HttpTestingController);
  const load = http.expectOne('/api/accounts/7/shares');
  expect(fixture.componentInstance.loading()).toBe(true);
  if (members) load.flush({ data: members, error: null });
  else load.flush({ data: null, error: 'boom' }, { status: 500, statusText: 'Server Error' });
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

  it('shows a message when the members cannot be loaded', () => {
    const { fixture, component } = setup(1, null);
    expect(component.loading()).toBe(false);
    expect(fixture.nativeElement.textContent).toContain('Could not load who has access.');
  });

  it('hides management controls below co-owner', () => {
    const { fixture, component } = setup(2, [OWNER, WRITER]);
    const el = fixture.nativeElement as HTMLElement;
    expect(component.canManage()).toBe(false);
    const buttons = Array.from(el.querySelectorAll('button')).map(b => b.textContent?.trim());
    expect(el.querySelector('[data-test="add"]')).toBeNull();
    expect(el.querySelector('[data-test="remove"]')).toBeNull();
    expect(buttons).toContain('Leave account');
  });

  const CO_CREATOR: AccountMember = { ...OWNER, level: 3 };
  const CO_OWNER: AccountMember = { user_id: 2, name: '', email: 'bob@x', level: 3, is_creator: false };
  const CAROL: AccountMember = { user_id: 3, name: 'Carol', email: 'carol@x', level: 2, is_creator: false };
  const confirmContent = (dialogOpen: ReturnType<typeof vi.fn>) =>
    ((dialogOpen.mock.calls[0] as unknown[])[1] as { data: { content: string } }).data.content;

  it('collects edits without sending them', () => {
    const { component, http } = setup(1, [OWNER, READER, CAROL]);
    component.setLevel(READER, 2);
    component.toggleRemove(CAROL);
    component.form.setValue({ email: ' x@y.z ', level: 2 });
    component.add();
    http.expectNone(() => true);
    expect(component.dirty()).toBe(true);
    expect(component.changes()).toEqual({
      add: [{ email: 'x@y.z', level: 2 }],
      update: [{ userId: 2, level: 2 }],
      remove: [3],
    });
    expect(component.form.getRawValue()).toEqual({ email: '', level: 1 });
  });

  it('drops an edit that returns to the stored level', () => {
    const { component } = setup(1, [OWNER, READER]);
    component.setLevel(READER, 2);
    component.setLevel(READER, 1);
    expect(component.dirty()).toBe(false);
  });

  it('removing a member drops their level edit, and undo keeps them', () => {
    const { component } = setup(1, [OWNER, READER]);
    component.setLevel(READER, 2);
    component.toggleRemove(READER);
    expect(component.changes()).toEqual({ add: [], update: [], remove: [2] });
    component.toggleRemove(READER);
    expect(component.dirty()).toBe(false);
  });

  it('refuses to add someone already in the list', () => {
    const { component } = setup(1, [OWNER, READER]);
    component.form.setValue({ email: 'BOB@x', level: 1 });
    component.add();
    expect(component.added()).toEqual([]);
    expect(TestBed.inject(NotificationService).showError).toHaveBeenCalledWith(null, 'This user is already in the list');
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

  it('cancel discards the draft', () => {
    const { component } = setup(1, [OWNER, READER]);
    component.setLevel(READER, 2);
    component.form.setValue({ email: 'x@y.z', level: 1 });
    component.add();
    component.cancel();
    expect(component.dirty()).toBe(false);
    expect(component.added()).toEqual([]);
  });

  it('applies the whole draft in one request and reloads once', async () => {
    const { component, http, dialogOpen, accounts, categories, transactions } = setup(1, [OWNER, READER]);
    component.setLevel(READER, 2);
    component.form.setValue({ email: 'x@y.z', level: 1 });
    component.add();
    const done = component.apply();
    await flushAsync();
    expect(dialogOpen).not.toHaveBeenCalled();
    const req = http.expectOne('/api/accounts/7/shares');
    expect(req.request.method).toBe('PUT');
    expect(req.request.body).toEqual({ add: [{ email: 'x@y.z', level: 1 }], update: [{ userId: 2, level: 2 }], remove: [] });
    const added: AccountMember = { user_id: 3, name: 'X', email: 'x@y.z', level: 1, is_creator: false };
    req.flush({ data: [OWNER, WRITER, added], error: null });
    await done;
    expect(component.members()).toEqual([OWNER, WRITER, added]);
    expect(component.dirty()).toBe(false);
    expect(accounts.reload).toHaveBeenCalledTimes(1);
    expect(categories.reload).toHaveBeenCalledTimes(1);
    expect(transactions.reload).toHaveBeenCalledTimes(1);
  });

  it('keeps the draft when Apply fails', async () => {
    const { component, http, accounts } = setup(1, [OWNER, READER]);
    component.setLevel(READER, 2);
    const done = component.apply();
    await flushAsync();
    http.expectOne('/api/accounts/7/shares').flush({ data: null, error: 'boom' }, { status: 404, statusText: 'Not Found' });
    await done;
    expect(component.members()).toEqual([OWNER, READER]);
    expect(component.changes().update).toEqual([{ userId: 2, level: 2 }]);
    expect(accounts.reload).not.toHaveBeenCalled();
  });

  it('confirms once, listing every warning', async () => {
    const { component, http, dialogOpen } = setup(1, [OWNER, READER, CAROL]);
    component.setLevel(READER, 3);
    component.toggleRemove(CAROL);
    const done = component.apply();
    await flushAsync();
    expect(dialogOpen).toHaveBeenCalledTimes(1);
    expect(confirmContent(dialogOpen)).toBe(
      '"Wallet" becomes co-owned: you will have equal rights with Bob. ' +
      'Remove Carol from "Wallet"? Their income and expenses on this account pass to the owner.',
    );
    http.expectOne('/api/accounts/7/shares').flush({ data: [CO_CREATOR, { ...READER, level: 3 }], error: null });
    await done;
  });

  it('sends nothing when the confirm is cancelled', async () => {
    const { component, http, dialogOpen } = setup(1, [OWNER, READER]);
    dialogOpen.mockReturnValue(of(false));
    component.toggleRemove(READER);
    await component.apply();
    http.expectNone('/api/accounts/7/shares');
    expect(component.changes().remove).toEqual([2]);
  });

  it("warns that changing the creator's level makes you the owner", async () => {
    const { component, http, dialogOpen } = setup(2, [CO_CREATOR, CO_OWNER]);
    component.setLevel(CO_CREATOR, 1);
    const done = component.apply();
    await flushAsync();
    expect(confirmContent(dialogOpen)).toBe(
      'Alice created "Wallet". Changing their level or removing them makes you the owner.',
    );
    http.expectOne('/api/accounts/7/shares').flush({ data: [], error: null });
    await done;
  });

  it('warns a co-owner lowering their own level', async () => {
    const { component, http, dialogOpen } = setup(2, [CO_CREATOR, CO_OWNER]);
    component.setLevel(CO_OWNER, 2);
    const done = component.apply();
    await flushAsync();
    expect(confirmContent(dialogOpen)).toBe(
      'Lower your own level on "Wallet" to Transactions? You will no longer be able to manage access.',
    );
    http.expectOne('/api/accounts/7/shares').flush({ data: [CO_CREATOR, { ...CO_OWNER, level: 2 }], error: null });
    await done;
  });

  it('warns the creator that lowering their own level gives up ownership', async () => {
    const { component, http, dialogOpen } = setup(1, [CO_CREATOR, CO_OWNER]);
    component.setLevel(CO_CREATOR, 1);
    const done = component.apply();
    await flushAsync();
    expect(confirmContent(dialogOpen)).toBe(
      'Lower your own level on "Wallet" to Read? Ownership passes to another co-owner, and you will no longer be able to manage access.',
    );
    http.expectOne('/api/accounts/7/shares').flush({ data: [{ ...CO_OWNER, level: 4, is_creator: true }, READER], error: null });
    await done;
  });

  it('ignores a second Apply while the confirm is open', async () => {
    const { component, http, dialogOpen } = setup(1, [OWNER, READER]);
    const answer = new Subject<boolean>();
    dialogOpen.mockReturnValue(answer);
    component.toggleRemove(READER);
    const first = component.apply();
    await flushAsync();
    expect(component.busy()).toBe(true);
    await component.apply();
    expect(dialogOpen).toHaveBeenCalledTimes(1);
    answer.next(false);
    answer.complete();
    await first;
    expect(component.busy()).toBe(false);
    http.expectNone('/api/accounts/7/shares');
  });

  it('disables Leave while the draft has edits', () => {
    const { fixture, component } = setup(2, [CO_CREATOR, CO_OWNER]);
    const leave = () => Array.from((fixture.nativeElement as HTMLElement).querySelectorAll('button'))
      .find(b => b.textContent?.trim() === 'Leave account')!;
    expect(leave().disabled).toBe(false);
    component.setLevel(CO_CREATOR, 1);
    fixture.detectChanges();
    expect(leave().disabled).toBe(true);
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
