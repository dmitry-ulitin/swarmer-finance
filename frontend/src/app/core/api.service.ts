import { HttpClient } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Category } from '../models/category';
import { Account } from '../models/account';
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

}
