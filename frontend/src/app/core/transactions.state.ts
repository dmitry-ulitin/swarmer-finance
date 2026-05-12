import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom, tap } from 'rxjs';
import { AuthService } from './auth.service';
import { Transaction, TransactionFilters, TransactionType, TransactionView, getTransactionType } from '../models/transaction';
import { ApiService, CreateTransactionRequest } from './api.service';

const PAGE_SIZE = 20;

@Injectable({ providedIn: 'root' })
export class TransactionsState {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);

  private readonly _transactions = signal<Transaction[]>([]);
  private readonly _offset = signal(0);
  private readonly _loading = signal(false);
  private readonly _hasMore = signal(true);
  private readonly _filters = signal<TransactionFilters>({});

  readonly transactions = this._transactions.asReadonly();
  readonly loading = this._loading.asReadonly();
  readonly hasMore = this._hasMore.asReadonly();
  readonly viewTransactions = computed<TransactionView[]>(() => {
    const accountFilter = this._filters().account;
    return this._transactions().map(t => ({
      ...t,
      accountName: this.getAccountName(t),
      formattedAmount: this.getFormattedAmount(t, accountFilter),
      type: getTransactionType(t),
    }));
  });

  setFilters(filters: TransactionFilters): void {
    this._filters.set(filters);
    this.reload();
  }

  loadMore(): void {
    if (this._loading() || !this.hasMore()) return;
    this.fetch(this._offset());
  }

  create(data: CreateTransactionRequest) {
    return this.api.createTransaction(data).pipe(tap(() => this.reload()));
  }

  reload(): void {
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
    const scale = t.scale ?? 2;
    const divisor = Math.pow(10, scale);
    const type = getTransactionType(t);

    if (type === TransactionType.Transfer) {
      const filterIds = accountFilter ?? [];
      const showCredit = filterIds.length > 0
        && t.credit_account != null
        && filterIds.includes(t.credit_account.id)
        && !(t.debit_account != null && filterIds.includes(t.debit_account.id));
      const val = showCredit ? t.credit / divisor : t.debit / divisor;
      const currency = showCredit ? (t.credit_account?.currency ?? '') : (t.debit_account?.currency ?? '');
      return `${val.toLocaleString()} ${currency}`;
    }

    const raw = type === TransactionType.Income ? t.debit : t.credit;
    const sign = type === TransactionType.Income ? '+' : '−';
    return `${sign}${(raw / divisor).toLocaleString()} ${t.currency ?? ''}`;
  }

  private async fetch(offset: number): Promise<void> {
    if (!this.auth.isAuthenticated()) return;
    this._loading.set(true);
    try {
      const r = await firstValueFrom(
        this.api.getTransactions({ ...this._filters(), offset, limit: PAGE_SIZE })
      );
      if (r.data) {
        const transactions = r.data || [];
        this._transactions.update(existing => [...existing, ...transactions]);
        this._hasMore.set(transactions.length === PAGE_SIZE);
        this._offset.set(offset + transactions.length);
      }
    } finally {
      this._loading.set(false);
    }
  }
}
