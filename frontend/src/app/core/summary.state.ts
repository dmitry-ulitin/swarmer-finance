import { Injectable, computed, effect, inject, untracked } from '@angular/core';
import { rxResource } from '@angular/core/rxjs-interop';
import { map } from 'rxjs';
import { ApiService, Summary } from './api.service';
import { AuthService } from './auth.service';

@Injectable({ providedIn: 'root' })
export class SummaryState {
  private readonly api = inject(ApiService);

  private readonly resource = rxResource<Summary | null, void>({
    stream: () => this.api.getSummary().pipe(map(r => r.data ?? null)),
  });

  readonly summary = computed(() => this.resource.value() ?? null);
  readonly loading = this.resource.isLoading;

  constructor() {
    const auth = inject(AuthService);
    effect(() => {
      if (auth.refreshCount() > 0) {
        untracked(() => this.resource.reload());
      }
    });
  }

  reload() {
    this.resource.reload();
  }
}
