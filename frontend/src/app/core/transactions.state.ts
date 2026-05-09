import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom, tap } from 'rxjs';
import { AuthService } from './auth.service';
import { Transaction, TransactionFilters } from '../models/transaction';
import { ApiService, CreateTransactionRequest } from './api.service';

const PAGE_SIZE = 20;

@Injectable({ providedIn: 'root' })
export class TransactionsState {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);

  private readonly _transactions = signal<Transaction[]>([]);
  private readonly _total = signal(0);
  private readonly _offset = signal(0);
  private readonly _loading = signal(false);
  private readonly _filters = signal<TransactionFilters>({});

  readonly transactions = this._transactions.asReadonly();
  readonly total = this._total.asReadonly();
  readonly loading = this._loading.asReadonly();
  readonly hasMore = computed(() => this._transactions().length < this._total());

  setFilters(filters: TransactionFilters): void {
    this._filters.set(filters);
    this._transactions.set([]);
    this._total.set(0);
    this._offset.set(0);
    this.fetch(0);
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
    this._total.set(0);
    this._offset.set(0);
    this.fetch(0);
  }

  private async fetch(offset: number): Promise<void> {
    if (!this.auth.isAuthenticated()) return;
    this._loading.set(true);
    try {
      const r = await firstValueFrom(
        this.api.getTransactions({ ...this._filters(), offset, limit: PAGE_SIZE })
      );
      if (r.data) {
        this._transactions.update(existing => [...existing, ...r.data!.transactions]);
        this._total.set(r.data.total);
        this._offset.set(offset + r.data.transactions.length);
      }
    } finally {
      this._loading.set(false);
    }
  }
}
