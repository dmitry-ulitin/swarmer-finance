import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Category } from '../models/category';
import { Account } from '../models/account';
import { Transaction, TransactionFilters } from '../models/transaction';
import { Observable } from 'rxjs';

export interface ApiResponse<T> {
  data: T | null;
  error: string | null;
}

@Injectable({
  providedIn: 'root',
})
export class ApiService {
  private http = inject(HttpClient);

  // Categories
  getCategories(): Observable<ApiResponse<Category[]>> {
    return this.http.get<ApiResponse<Category[]>>('/api/categories');
  }

  createCategory(data: { name: string; parentId: number; color?: string; icon?: string }): Observable<ApiResponse<Category>> {
    return this.http.post<ApiResponse<Category>>('/api/categories', data);
  }

  updateCategory(id: number, data: { name?: string; color?: string; icon?: string }): Observable<ApiResponse<Category>> {
    return this.http.put<ApiResponse<Category>>(`/api/categories/${id}`, data);
  }

  deleteCategory(id: number): Observable<ApiResponse<{ success: boolean }>> {
    return this.http.delete<ApiResponse<{ success: boolean }>>(`/api/categories/${id}`);
  }

  // Accounts
  getAccounts(): Observable<ApiResponse<Account[]>> {
    return this.http.get<ApiResponse<Account[]>>('/api/accounts');
  }

  createAccount(data: { name: string; currency: string; startBalance: number }): Observable<ApiResponse<Account>> {
    return this.http.post<ApiResponse<Account>>('/api/accounts', data);
  }

  updateAccount(id: number, data: { name?: string; currency?: string; startBalance?: number }): Observable<ApiResponse<Account>> {
    return this.http.put<ApiResponse<Account>>(`/api/accounts/${id}`, data);
  }

  deleteAccount(id: number): Observable<ApiResponse<{ success: boolean }>> {
    return this.http.delete<ApiResponse<{ success: boolean }>>(`/api/accounts/${id}`);
  }

  // Transactions
  getTransactions(filters: TransactionFilters & { offset?: number; limit?: number } = {}): Observable<ApiResponse<{ transactions: Transaction[]; total: number }>> {
    let params = new HttpParams();
    if (filters.from) params = params.set('from', filters.from);
    if (filters.to) params = params.set('to', filters.to);
    if (filters.type) params = params.set('type', filters.type);
    if (filters.details) params = params.set('details', filters.details);
    if (filters.offset != null) params = params.set('offset', filters.offset);
    if (filters.limit != null) params = params.set('limit', filters.limit);
    filters.category?.forEach(id => { params = params.append('category', id); });
    filters.account?.forEach(id => { params = params.append('account', id); });
    return this.http.get<ApiResponse<{ transactions: Transaction[]; total: number }>>('/api/transactions', { params });
  }

}
