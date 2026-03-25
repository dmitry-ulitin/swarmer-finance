import { Injectable, computed, effect, inject, resource, untracked } from '@angular/core';
import { firstValueFrom, tap } from 'rxjs';
import { AuthService } from './auth.service';
import { Category, withComputedFields } from '../models/category';
import { ApiService } from './api.service';

@Injectable({ providedIn: 'root' })
export class CategoriesState {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);

  private readonly resource = resource<Category[], boolean>({
    params: () => this.auth.isAuthenticated(),
    loader: async ({ params }) => {
      if (!params) return [];
      const r = await firstValueFrom(this.api.getCategories());
      return r.data ?? [];
    }
  });

  readonly categories = computed(() => withComputedFields(this.resource.value() ?? []));
  readonly loading = this.resource.isLoading;

  reload() {
    this.resource.reload();
  }

  create(data: { name: string; parentId: number; color?: string; icon?: string }) {
    return this.api.createCategory(data).pipe(tap(() => this.resource.reload()));
  }

  update(id: number, data: { name?: string; color?: string; icon?: string }) {
    return this.api.updateCategory(id, data).pipe(tap(() => this.resource.reload()));
  }

  delete(id: number) {
    return this.api.deleteCategory(id).pipe(tap(() => this.resource.reload()));
  }
}
