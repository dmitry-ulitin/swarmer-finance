import { computed, DestroyRef, inject, Injectable, signal } from '@angular/core';

interface Handler {
  hint: string;
  reload: () => void;
}

/** The reload action of the page on screen, which the header's refresh button runs. */
@Injectable({ providedIn: 'root' })
export class PageReload {
  private readonly current = signal<Handler | null>(null);
  readonly hint = computed(() => this.current()?.hint ?? null);

  /** Registers for the lifetime of the calling component, so call it in an injection context. */
  register(hint: string, reload: () => void): void {
    const handler = { hint, reload };
    this.current.set(handler);
    // Guarded: the next page may register before this one is destroyed.
    inject(DestroyRef).onDestroy(() => {
      if (this.current() === handler) this.current.set(null);
    });
  }

  reload(): void {
    this.current()?.reload();
  }
}
