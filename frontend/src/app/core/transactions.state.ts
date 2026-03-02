import { Injectable, computed, effect, inject, signal, untracked } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { map, tap, of } from 'rxjs';
import { ApiService, Transaction, TransactionListResponse } from './api.service';
import { AuthService } from './auth.service';

interface TransactionFilters {
  from?: string;
  to?: string;
  category?: number;
  type?: string;
  page?: number;
  limit?: number;
}

@Injectable({ providedIn: 'root' })
export class TransactionsState {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);
  private readonly _filters = signal<TransactionFilters>({});

  private readonly resource = rxResource<TransactionListResponse, boolean>({
    params: () => this.auth.isAuthenticated(),
    stream: ({ params }) => params ? this.api.getTransactions(this._filters()).pipe(
      map(r => r.data ?? { transactions: [], total: 0 })
    ) : of({ transactions: [], total: 0 })
  });

  readonly transactions = computed(() => this.resource.value()?.transactions ?? []);
  readonly total = computed(() => this.resource.value()?.total ?? 0);
  readonly loading = this.resource.isLoading;

  constructor() {
    effect(() => {
      if (this.auth.refreshCount() > 0) {
        untracked(() => this.resource.reload());
      }
    });
  }

  reload() {
    this.resource.reload();
  }

  setFilters(filters: TransactionFilters) {
    this._filters.set(filters);
  }

  create(data: { categoryId: number; amount: number; date: string; description?: string }) {
    return this.api.createTransaction(data).pipe(tap(() => this.resource.reload()));
  }

  update(id: number, data: { categoryId?: number; amount?: number; date?: string; description?: string }) {
    return this.api.updateTransaction(id, data).pipe(tap(() => this.resource.reload()));
  }

  delete(id: number) {
    return this.api.deleteTransaction(id).pipe(tap(() => this.resource.reload()));
  }
}
