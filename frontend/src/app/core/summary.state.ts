import { Injectable, computed, effect, inject, untracked } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { map, of } from 'rxjs';
import { ApiService, Summary } from './api.service';
import { AuthService } from './auth.service';

@Injectable({ providedIn: 'root' })
export class SummaryState {
  private readonly api = inject(ApiService);
  private readonly auth = inject(AuthService);

  private readonly resource = rxResource<Summary | null, boolean>({
    params: () => this.auth.isAuthenticated(),
    stream: ({params}) => params ? this.api.getSummary().pipe(map(r => r.data ?? null)) : of(null)
  });
  

  readonly summary = computed(() => this.resource.value() ?? null);
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
}
