import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { vi } from 'vitest';
import { AccountTreeNode } from './account-tree-node';
import { AccountListStore } from '../account-list.store';
import { TransactionsState } from '../../../../core/transactions.state';
import { AuthService } from '../../../../core/auth.service';
import { ImportDialogService } from '../../../import/import-dialog.service';
import { AccountSyncService } from '../../account-sync.service';
import type { AccountLeafItem } from '../../../../core/account-tree';
import type { BankLink } from '../../../../models/bank';

describe('AccountTreeNode bank actions', () => {
  const importDialog = { open: vi.fn(), openFromBank: vi.fn() };

  function render(overrides: { bank_link?: Partial<BankLink> | null; access_level?: number }) {
    TestBed.configureTestingModule({
      imports: [AccountTreeNode],
      providers: [
        { provide: AccountListStore, useValue: {} },
        { provide: TransactionsState, useValue: { selectedAccountIds: signal([]) } },
        { provide: AuthService, useValue: { user: signal(null) } },
        { provide: ImportDialogService, useValue: importDialog },
        { provide: AccountSyncService, useValue: { syncing: signal(new Set()) } },
      ],
    });
    const account = { id: 1, type: 'bank', currency: 'EUR', scale: 2, balance: null, displayName: 'LHV', ...overrides };
    const fixture = TestBed.createComponent(AccountTreeNode);
    fixture.componentRef.setInput('item', { kind: 'account', account } as unknown as AccountLeafItem);
    fixture.detectChanges();
    return { account, labels: () => buttons(fixture.nativeElement), root: fixture.nativeElement as HTMLElement };
  }

  const buttons = (root: HTMLElement) =>
    [...root.querySelectorAll('button:not(.row-name)')].map(b => b.textContent?.trim());

  beforeEach(() => vi.clearAllMocks());

  it('offers import on an unlinked bank account', () => {
    expect(render({ bank_link: null }).labels()).toEqual(['Import']);
  });

  it.each(['active', 'expiring'] as const)('offers the bank load instead of import when the link is %s', status => {
    expect(render({ bank_link: { status } }).labels()).toEqual(['Load from bank']);
  });

  it.each(['expired', 'pending', 'unmapped'] as const)('falls back to import when the link is %s', status => {
    expect(render({ bank_link: { status } }).labels()).toEqual(['Import']);
  });

  it('offers neither without write access', () => {
    expect(render({ bank_link: { status: 'active' }, access_level: 1 }).labels()).toEqual([]);
  });

  it('opens the bank load', () => {
    const { account, root } = render({ bank_link: { status: 'active' } });
    root.querySelector<HTMLButtonElement>('button:not(.row-name)')!.click();
    expect(importDialog.openFromBank).toHaveBeenCalledWith(account);
    expect(importDialog.open).not.toHaveBeenCalled();
  });
});
