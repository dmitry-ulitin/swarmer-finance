import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom, tap } from 'rxjs';
import { AuthService } from './auth.service';
import { Transaction, TransactionAccount, TransactionFilters, TransactionType, TransactionView, getTransactionType } from '../models/transaction';
import { ApiService, CreateTransactionRequest } from './api.service';
import { AccountsState } from './accounts.state';

const PAGE_SIZE = 20;

function sameAccountFilter(a: number[], b: number[]): boolean {
  if (a.length !== b.length) return false;
  const setA = new Set(a);
  return b.every(id => setA.has(id));
}

@Injectable({ providedIn: 'root' })
export class TransactionsState {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  protected readonly accounts = inject(AccountsState);

  private readonly _transactions = signal<Transaction[]>([]);
  private readonly _offset = signal(0);
  private readonly _loading = signal(false);
  private readonly _hasMore = signal(true);
  private readonly _filters = signal<TransactionFilters>({});
  private readonly _selectedTransaction = signal<Transaction | null>(null);

  readonly transactions = this._transactions.asReadonly();
  readonly loading = this._loading.asReadonly();
  readonly hasMore = this._hasMore.asReadonly();
  readonly selectedAccountIds = computed(() => this._filters().account ?? []);
  readonly selectedTransaction = this._selectedTransaction.asReadonly();
  readonly viewTransactions = computed<TransactionView[]>(() => {
    const accountFilter = this._filters().account;
    return this._transactions().map(t => ({
      ...t,
      accountName: this.getAccountName(t),
      formattedAmount: this.getFormattedAmount(t, accountFilter),
      formattedBalance: this.getFormattedBalance(t, accountFilter),
      type: getTransactionType(t),
    }));
  });

  setFilters(filters: TransactionFilters): void {
    this._filters.set(filters);
    this.reload();
  }

  selectAllAccounts(): void {
    if (!this._filters().account) return;
    this._filters.update(f => ({ ...f, account: undefined }));
    this.reload();
  }

  selectAccount(id: number): void {
    this.selectAccounts([id]);
  }

  toggleAccount(id: number): void {
    const current = this._filters().account ?? [];
    const next = current.includes(id) ? current.filter(a => a !== id) : [...current, id];
    this.selectAccounts(next);
  }

  selectAccounts(ids: number[]): void {
    const current = this._filters().account ?? [];
    const next = this.accounts.accounts().every(a => ids.includes(a.id)) ? [] : ids;
    if (sameAccountFilter(current, next)) return;
    this._filters.update(f => ({ ...f, account: next.length ? next : undefined }));
    this.reload();
  }

  toggleAccounts(ids: number[]): void {
    const current = this._filters().account ?? [];
    const allSelected = ids.every(id => current.includes(id));
    const next = allSelected
      ? current.filter(id => !ids.includes(id))
      : [...new Set([...current, ...ids])];
    this.selectAccounts(next);
  }

  loadMore(): void {
    if (this._loading() || !this.hasMore()) return;
    this.fetch(this._offset());
  }

  create(data: CreateTransactionRequest) {
    return this.api.createTransaction(data).pipe(tap(() => this.reload()));
  }

  update(id: number, data: Partial<CreateTransactionRequest>) {
    return this.api.updateTransaction(id, data).pipe(tap(() => this.reload()));
  }

  delete(id: number) {
    return this.api.deleteTransaction(id).pipe(tap(() => this.reload()));
  }

  selectTransaction(transaction: Transaction | null): void {
    const current = this._selectedTransaction();
    this._selectedTransaction.set(current?.id === transaction?.id ? null : transaction);
  }

  reload(): void {
    this._selectedTransaction.set(null);
    this._transactions.set([]);
    this._hasMore.set(true);
    this._offset.set(0);
    this.fetch(0);
  }

  private getAccountName(t: Transaction): string {
    const type = getTransactionType(t);
    if (type === TransactionType.Expense) return t.debit_account?.name ?? '';
    if (type === TransactionType.Income) return t.credit_account?.name ?? '';
    return `${t.debit_account?.name ?? '?'} → ${t.credit_account?.name ?? '?'}`;
  }

  private getFormattedAmount(t: Transaction, accountFilter?: number[]): string {
    const type = getTransactionType(t);

    if (type === TransactionType.Transfer) {
      const filterIds = accountFilter ?? [];
      const showCredit = filterIds.length > 0
        && t.credit_account != null
        && filterIds.includes(t.credit_account.id)
        && !(t.debit_account != null && filterIds.includes(t.debit_account.id));
      const scale = showCredit
        ? (t.credit_account?.scale ?? t.scale ?? 2)
        : (t.debit_account?.scale ?? t.scale ?? 2);
      const val = (showCredit ? t.credit : t.debit) / Math.pow(10, scale);
      const currency = showCredit
        ? (t.credit_account?.currency ?? t.currency ?? '')
        : (t.debit_account?.currency ?? t.currency ?? '');
      return this.formatAmount(val, currency, scale);
    }

    if (type === TransactionType.Income) {
      const scale = t.credit_account?.scale ?? t.scale ?? 2;
      const currency = t.credit_account?.currency ?? t.currency ?? '';
      return `+${this.formatAmount(t.credit / Math.pow(10, scale), currency, scale)}`;
    }

    const scale = t.debit_account?.scale ?? t.scale ?? 2;
    const currency = t.debit_account?.currency ?? t.currency ?? '';
    return `−${this.formatAmount(t.debit / Math.pow(10, scale), currency, scale)}`;
  }

  private getFormattedBalance(t: Transaction, accountFilter?: number[]): string {
    const type = getTransactionType(t);
    let account: TransactionAccount | null = null;

    if (type === TransactionType.Transfer) {
      const filterIds = accountFilter ?? [];
      const showCredit = filterIds.length > 0
        && t.credit_account != null
        && filterIds.includes(t.credit_account.id)
        && !(t.debit_account != null && filterIds.includes(t.debit_account.id));
      account = showCredit ? t.credit_account : t.debit_account;
    } else if (type === TransactionType.Income) {
      account = t.credit_account;
    } else {
      account = t.debit_account;
    }

    if (account?.balance == null) return '';
    const scale = account.scale;
    return this.formatAmount(account.balance / Math.pow(10, scale), account.currency, scale);
  }

  private formatAmount(value: number, currency: string, scale: number): string {
    try {
      return new Intl.NumberFormat(undefined, {
        style: 'currency',
        currency,
        minimumFractionDigits: scale,
        maximumFractionDigits: scale,
      }).format(value);
    } catch {
      return value.toLocaleString(undefined, { minimumFractionDigits: scale, maximumFractionDigits: scale });
    }
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
