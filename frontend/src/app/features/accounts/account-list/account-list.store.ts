import { Injectable, computed, signal } from '@angular/core';

@Injectable()
export class AccountListStore {
  private readonly _selectedIds = signal<ReadonlySet<number>>(new Set());
  private readonly _expandedPaths = signal<ReadonlySet<string>>(new Set());

  readonly selectedIds = this._selectedIds.asReadonly();
  readonly selectedIdsArray = computed(() => [...this._selectedIds()]);
  readonly isAllSelected = computed(() => this._selectedIds().size === 0);

  selectAll(): void {
    this._selectedIds.set(new Set());
  }

  selectAccount(id: number): void {
    this._selectedIds.set(new Set([id]));
  }

  toggleAccount(id: number): void {
    const next = new Set(this._selectedIds());
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    this._selectedIds.set(next);
  }

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
