import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { firstValueFrom, tap } from 'rxjs';
import { AuthService } from './auth.service';
import { Transaction, TransactionAccount, TransactionFilters, TransactionType, TransactionView, getTransactionType } from '../models/transaction';
import { ApiService, TransactionRequest } from './api.service';
import { AccountsState } from './accounts.state';

const PAGE_SIZE = 20;

/** Inclusive `YYYY-MM-DD` bounds of the transaction date filter. */
export interface DateRange {
  from: string;
  to: string;
}

function sameAccountFilter(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  const setA = new Set(a);
  return b.every(id => setA.has(id));
}

/**
 * The side a transaction is shown on: a transfer shows its receiving
 * side only when the account filter has that account but not the sender.
 */
function shownSide(t: Transaction, type: TransactionType, accountFilter: number[]): 'debit' | 'credit' {
  if (type === TransactionType.Income) return 'credit';
  if (type === TransactionType.Expense) return 'debit';
  const filtered = (a: TransactionAccount | null) => a != null && accountFilter.includes(a.id);
  return filtered(t.credit_account) && !filtered(t.debit_account) ? 'credit' : 'debit';
}

function accountName(t: Transaction, type: TransactionType): string {
  if (type === TransactionType.Expense) return t.debit_account?.name ?? '';
  if (type === TransactionType.Income) return t.credit_account?.name ?? '';
  return `${t.debit_account?.name ?? '?'} → ${t.credit_account?.name ?? '?'}`;
}

function toView(t: Transaction, accountFilter: number[]): TransactionView {
  const type = getTransactionType(t);
  const side = shownSide(t, type, accountFilter);
  const account = side === 'credit' ? t.credit_account : t.debit_account;
  return {
    ...t,
    accountName: accountName(t, type),
    amount: t[side],
    amountCurrency: account?.currency ?? t.currency ?? '',
    amountScale: account?.scale ?? t.scale ?? 2,
    balance: account?.balance ?? null,
    balanceCurrency: account?.currency ?? '',
    balanceScale: account?.scale ?? 2,
    type,
  };
}

@Injectable({ providedIn: 'root' })
export class TransactionsState {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly accounts = inject(AccountsState);

  private readonly _transactions = signal<Transaction[]>([]);
  private readonly _offset = signal(0);
  private readonly _loading = signal(false);
  private readonly _hasMore = signal(true);
  private readonly _filters = signal<TransactionFilters>({});
  private readonly _selectedTransaction = signal<Transaction | null>(null);
  private readonly _revision = signal(0);

  readonly transactions = this._transactions.asReadonly();
  readonly loading = this._loading.asReadonly();
  readonly hasMore = this._hasMore.asReadonly();
  readonly selectedAccountIds = computed(() => this._filters().accounts ?? []);
  readonly selectedCategoryIds = computed(() => this._filters().categories ?? []);
  readonly dateRange = computed<DateRange | null>(() => {
    const { from, to } = this._filters();
    return from && to ? { from, to } : null;
  });
  readonly selectedTransaction = this._selectedTransaction.asReadonly();
  /** Bumped on every reload, so views derived from the transactions refetch too. */
  readonly revision = this._revision.asReadonly();
  readonly viewTransactions = computed<TransactionView[]>(() => {
    const accountFilter = this.selectedAccountIds();
    return this._transactions().map(t => toView(t, accountFilter));
  });

  constructor() {
    // A root singleton outlives the session: the next user must not inherit filters.
    effect(() => {
      if (this.auth.isAuthenticated()) return;
      untracked(() => {
        this._filters.set({});
        this._selectedTransaction.set(null);
        this._transactions.set([]);
        this._hasMore.set(true);
        this._offset.set(0);
      });
    });
  }

  setFilters(filters: TransactionFilters): void {
    this._filters.set(filters);
    this.reload();
  }

  setDetails(details: string | undefined): void {
    if (this._filters().details === details) return;
    this.patchFilters({ details });
  }

  setDateRange(range: DateRange | null): void {
    const current = this.dateRange();
    if (current?.from === range?.from && current?.to === range?.to) return;
    this.patchFilters({ from: range?.from, to: range?.to });
  }

  selectAllAccounts(): void {
    if (!this._filters().accounts) return;
    this.patchFilters({ accounts: undefined });
  }

  selectAccount(id: number): void {
    this.selectAccounts([id]);
  }

  toggleAccount(id: number): void {
    const current = this._filters().accounts ?? [];
    const next = current.includes(id) ? current.filter(a => a !== id) : [...current, id];
    this.selectAccounts(next);
  }

  selectAccounts(ids: number[]): void {
    const current = this._filters().accounts ?? [];
    const next = this.accounts.accounts().every(a => ids.includes(a.id)) ? [] : ids;
    if (sameAccountFilter(current, next)) return;
    this.patchFilters({ accounts: next.length ? next : undefined });
  }

  toggleAccounts(ids: number[]): void {
    const current = this._filters().accounts ?? [];
    const allSelected = ids.every(id => current.includes(id));
    const next = allSelected
      ? current.filter(id => !ids.includes(id))
      : [...new Set([...current, ...ids])];
    this.selectAccounts(next);
  }

  /** Filters by this category alone; selecting the sole selected category clears the filter. */
  selectCategory(id: number): void {
    const current = this.selectedCategoryIds();
    this.setCategories(current.length === 1 && current[0] === id ? [] : [id]);
  }

  toggleCategory(id: number): void {
    const current = this.selectedCategoryIds();
    this.setCategories(current.includes(id) ? current.filter(c => c !== id) : [...current, id]);
  }

  private setCategories(ids: number[]): void {
    this.patchFilters({ categories: ids.length ? ids : undefined });
  }

  private patchFilters(patch: Partial<TransactionFilters>): void {
    this._filters.update(f => ({ ...f, ...patch }));
    this.reload();
  }

  loadMore(): void {
    if (this._loading() || !this.hasMore()) return;
    this.fetch(this._offset());
  }

  create(data: TransactionRequest) {
    return this.api.createTransaction(data).pipe(tap(() => this.reloadWithAccounts()));
  }

  update(id: number, data: Partial<TransactionRequest>) {
    return this.api.updateTransaction(id, data).pipe(tap(() => this.reloadWithAccounts()));
  }

  delete(id: number) {
    return this.api.deleteTransaction(id).pipe(tap(() => this.reloadWithAccounts()));
  }

  selectTransaction(transaction: Transaction | null): void {
    const current = this._selectedTransaction();
    this._selectedTransaction.set(current?.id === transaction?.id ? null : transaction);
  }

  reload(): void {
    this._revision.update(r => r + 1);
    this._selectedTransaction.set(null);
    this._transactions.set([]);
    this._hasMore.set(true);
    this._offset.set(0);
    this.fetch(0);
  }

  /** After a write: transactions and account balances both change. */
  private reloadWithAccounts(): void {
    this.reload();
    this.accounts.reload();
  }

  private async fetch(offset: number): Promise<void> {
    if (!this.auth.isAuthenticated()) return;
    this._loading.set(true);
    try {
      const r = await firstValueFrom(
        this.api.getTransactions({ ...this._filters(), offset, limit: PAGE_SIZE })
      );
      if (r.data) {
        const transactions = r.data;
        this._transactions.update(existing => [...existing, ...transactions]);
        this._hasMore.set(transactions.length === PAGE_SIZE);
        this._offset.set(offset + transactions.length);
      }
    } finally {
      this._loading.set(false);
    }
  }
}
