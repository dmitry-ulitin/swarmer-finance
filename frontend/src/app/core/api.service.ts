import { HttpClient, HttpParams } from '@angular/common/http';
import { inject, Injectable } from '@angular/core';
import { Category, CategoryCreatePayload, CategoryDeletePreview, CategoryUpdatePayload } from '../models/category';
import { Account, AccountMember, AccountPayload, AccountPurgeResult, AccountSyncResult, ShareLevel } from '../models/account';
import { CategorySummary, Transaction, TransactionFilters } from '../models/transaction';
import { ImportParseResult, ImportReconcileResult, ImportReconcileRow } from '../models/import';
import { BankAspsp, BankConnection, BankCredentials, bankRedirectUrl } from '../models/bank';
import { Observable } from 'rxjs';

export interface ApiResponse<T> {
  data: T | null;
  error: string | null;
}

export interface TransactionRequest {
  categoryId?: number | null;
  debitAccountId?: number | null;
  creditAccountId?: number | null;
  debit: number;
  credit: number;
  date: string;
  description?: string | null;
  payee?: string | null;
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

  createCategory(data: CategoryCreatePayload): Observable<ApiResponse<Category>> {
    return this.http.post<ApiResponse<Category>>('/api/categories', data);
  }

  updateCategory(id: number, data: CategoryUpdatePayload): Observable<ApiResponse<Category>> {
    return this.http.put<ApiResponse<Category>>(`/api/categories/${id}`, data);
  }

  getCategoryDeletePreview(id: number): Observable<ApiResponse<CategoryDeletePreview>> {
    return this.http.get<ApiResponse<CategoryDeletePreview>>(`/api/categories/${id}/delete-preview`);
  }

  deleteCategory(id: number): Observable<ApiResponse<{ success: boolean }>> {
    return this.http.delete<ApiResponse<{ success: boolean }>>(`/api/categories/${id}`);
  }

  // Accounts
  getAccounts(): Observable<ApiResponse<Account[]>> {
    return this.http.get<ApiResponse<Account[]>>('/api/accounts');
  }

  createAccount(data: AccountPayload): Observable<ApiResponse<Account>> {
    return this.http.post<ApiResponse<Account>>('/api/accounts', data);
  }

  updateAccount(id: number, data: AccountPayload): Observable<ApiResponse<Account>> {
    return this.http.put<ApiResponse<Account>>(`/api/accounts/${id}`, data);
  }

  deleteAccount(id: number): Observable<ApiResponse<{ success: boolean }>> {
    return this.http.delete<ApiResponse<{ success: boolean }>>(`/api/accounts/${id}`);
  }

  purgeAccountTransactions(id: number): Observable<ApiResponse<AccountPurgeResult>> {
    return this.http.delete<ApiResponse<AccountPurgeResult>>(`/api/accounts/${id}/transactions`);
  }

  deleteAccountWithTransactions(id: number): Observable<ApiResponse<AccountPurgeResult>> {
    return this.http.delete<ApiResponse<AccountPurgeResult>>(`/api/accounts/${id}`, { params: { withTransactions: 'true' } });
  }

  syncAccount(id: number): Observable<ApiResponse<AccountSyncResult>> {
    return this.http.post<ApiResponse<AccountSyncResult>>(`/api/accounts/${id}/sync`, {});
  }

  getAccountShares(accountId: number): Observable<ApiResponse<AccountMember[]>> {
    return this.http.get<ApiResponse<AccountMember[]>>(`/api/accounts/${accountId}/shares`);
  }

  addAccountShare(accountId: number, email: string, level: ShareLevel): Observable<ApiResponse<AccountMember[]>> {
    return this.http.post<ApiResponse<AccountMember[]>>(`/api/accounts/${accountId}/shares`, { email, level });
  }

  updateAccountShare(accountId: number, userId: number, level: ShareLevel): Observable<ApiResponse<AccountMember[]>> {
    return this.http.put<ApiResponse<AccountMember[]>>(`/api/accounts/${accountId}/shares/${userId}`, { level });
  }

  removeAccountShare(accountId: number, userId: number): Observable<ApiResponse<AccountMember[]>> {
    return this.http.delete<ApiResponse<AccountMember[]>>(`/api/accounts/${accountId}/shares/${userId}`);
  }

  // Transactions
  createTransaction(data: TransactionRequest): Observable<ApiResponse<Transaction>> {
    return this.http.post<ApiResponse<Transaction>>('/api/transactions', data);
  }

  getTransactions(filters: TransactionFilters & { offset?: number; limit?: number } = {}): Observable<ApiResponse<Transaction[]>> {
    let params = new HttpParams();
    if (filters.from) params = params.set('from', filters.from);
    if (filters.to) params = params.set('to', filters.to);
    if (filters.type) params = params.set('type', filters.type);
    if (filters.details) params = params.set('details', filters.details);
    if (filters.offset != null) params = params.set('offset', filters.offset);
    if (filters.limit != null) params = params.set('limit', filters.limit);
    filters.categories?.forEach(id => { params = params.append('categories', id); });
    filters.accounts?.forEach(id => { params = params.append('accounts', id); });
    return this.http.get<ApiResponse<Transaction[]>>('/api/transactions', { params });
  }

  getCategorySummary(filters: Pick<TransactionFilters, 'accounts' | 'from' | 'to'>): Observable<ApiResponse<CategorySummary>> {
    let params = new HttpParams();
    if (filters.from) params = params.set('from', filters.from);
    if (filters.to) params = params.set('to', filters.to);
    filters.accounts?.forEach(id => { params = params.append('accounts', id); });
    return this.http.get<ApiResponse<CategorySummary>>('/api/transactions/summary', { params });
  }

  updateTransaction(id: number, data: Partial<TransactionRequest>): Observable<ApiResponse<Transaction>> {
    return this.http.put<ApiResponse<Transaction>>(`/api/transactions/${id}`, data);
  }

  deleteTransaction(id: number): Observable<ApiResponse<null>> {
    return this.http.delete<ApiResponse<null>>(`/api/transactions/${id}`);
  }

  // Import
  /** `content` is the statement file base64-encoded; `format` omitted means detect. */
  parseStatement(accountId: number, content: string, format?: string | null): Observable<ApiResponse<ImportParseResult>> {
    return this.http.post<ApiResponse<ImportParseResult>>('/api/import/parse', {
      accountId,
      content,
      ...(format ? { format } : {}),
    });
  }

  reconcileImport(accountId: number, rows: ImportReconcileRow[], bankLoadedTo?: string): Observable<ApiResponse<ImportReconcileResult>> {
    return this.http.post<ApiResponse<ImportReconcileResult>>('/api/import/reconcile', {
      accountId,
      rows,
      ...(bankLoadedTo ? { bankLoadedTo } : {}),
    });
  }

  // Bank sync
  getBankCredentials(): Observable<ApiResponse<BankCredentials>> {
    return this.http.get<ApiResponse<BankCredentials>>('/api/bank/credentials');
  }

  saveBankCredentials(body: { applicationId: string; privateKey: string }): Observable<ApiResponse<BankCredentials>> {
    return this.http.put<ApiResponse<BankCredentials>>('/api/bank/credentials', body);
  }

  deleteBankCredentials(): Observable<ApiResponse<{ success: boolean }>> {
    return this.http.delete<ApiResponse<{ success: boolean }>>('/api/bank/credentials');
  }

  getBankAspsps(country: string): Observable<ApiResponse<BankAspsp[]>> {
    return this.http.get<ApiResponse<BankAspsp[]>>('/api/bank/aspsps', { params: { country } });
  }

  getBankConnections(): Observable<ApiResponse<BankConnection[]>> {
    return this.http.get<ApiResponse<BankConnection[]>>('/api/bank/connections');
  }

  /** Returns the bank's consent page address. */
  startBankConnection(aspspName: string, country: string): Observable<ApiResponse<{ url: string }>> {
    return this.http.post<ApiResponse<{ url: string }>>('/api/bank/connections', {
      aspspName,
      country,
      redirectUrl: bankRedirectUrl(),
    });
  }

  reconnectBank(id: number): Observable<ApiResponse<{ url: string }>> {
    return this.http.post<ApiResponse<{ url: string }>>(`/api/bank/connections/${id}/reconnect`, {
      redirectUrl: bankRedirectUrl(),
    });
  }

  completeBankConnection(state: string, code: string): Observable<ApiResponse<BankConnection>> {
    return this.http.post<ApiResponse<BankConnection>>('/api/bank/connections/complete', { state, code });
  }

  deleteBankConnection(id: number): Observable<ApiResponse<{ success: boolean }>> {
    return this.http.delete<ApiResponse<{ success: boolean }>>(`/api/bank/connections/${id}`);
  }

  /** Loads bank transactions into an import preview; `dateFrom` only matters before the first load. */
  loadFromBank(accountId: number, dateFrom?: string): Observable<ApiResponse<ImportParseResult>> {
    return this.http.post<ApiResponse<ImportParseResult>>('/api/import/bank', {
      accountId,
      ...(dateFrom ? { dateFrom } : {}),
    });
  }
}
