import { describe, it, expect, beforeEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection, signal } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { of } from 'rxjs';
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
  const transactions = { reload: vi.fn() };
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
});
