import { Injectable, computed, effect, inject, untracked } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { map, tap, of } from 'rxjs';
import { ApiService, Category } from './api.service';
import { AuthService } from './auth.service';

@Injectable({ providedIn: 'root' })
export class CategoriesState {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);

  private readonly resource = rxResource<Category[], boolean>({
    params: () => this.auth.isAuthenticated(),
    stream: ({params}) => params ? this.api.getCategories().pipe(map(r => r.data ?? [])) : of([])
  });

  readonly categories = computed(() => this.resource.value() ?? []);
  readonly loading = this.resource.isLoading;

  readonly leafCategories = computed(() => {
    const getLeaves = (items: Category[]): Category[] =>
      items.flatMap(item => item.children?.length ? getLeaves(item.children) : [item]);
    return getLeaves(this.categories());
  });

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

  create(data: { name: string; parentId: number; color?: string }) {
    return this.api.createCategory(data).pipe(tap(() => this.resource.reload()));
  }

  update(id: number, data: { name?: string; color?: string }) {
    return this.api.updateCategory(id, data).pipe(tap(() => this.resource.reload()));
  }

  delete(id: number) {
    return this.api.deleteCategory(id).pipe(tap(() => this.resource.reload()));
  }
}
