import { Injectable, signal } from '@angular/core';

@Injectable()
export class AccountListStore {
  private readonly _expandedPaths = signal<ReadonlySet<string>>(new Set());

  toggleExpanded(path: string): void {
    const next = new Set(this._expandedPaths());
    if (next.has(path)) {
      next.delete(path);
    } else {
      next.add(path);
    }
    this._expandedPaths.set(next);
  }

  isExpanded(path: string): boolean {
    return this._expandedPaths().has(path);
  }
}
