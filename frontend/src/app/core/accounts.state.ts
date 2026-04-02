import { Injectable, computed, inject, resource } from '@angular/core';
import { firstValueFrom, tap } from 'rxjs';
import { AuthService } from './auth.service';
import { Account } from '../models/account';
import { ApiService } from './api.service';

@Injectable({ providedIn: 'root' })
export class AccountsState {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);

  private readonly resource = resource<Account[], boolean>({
    params: () => this.auth.isAuthenticated(),
    loader: async ({ params }) => {
      if (!params) return [];
      const r = await firstValueFrom(this.api.getAccounts());
      return r.data ?? [];
    }
  });

  readonly accounts = computed(() => this.resource.value() ?? []);
  readonly loading = this.resource.isLoading;

  reload() {
    this.resource.reload();
  }

  create(data: { name: string; currency: string; startBalance: number }) {
    return this.api.createAccount(data).pipe(tap(() => this.resource.reload()));
  }

  update(id: number, data: { name?: string; currency?: string; startBalance?: number }) {
    return this.api.updateAccount(id, data).pipe(tap(() => this.resource.reload()));
  }

  delete(id: number) {
    return this.api.deleteAccount(id).pipe(tap(() => this.resource.reload()));
  }
}
