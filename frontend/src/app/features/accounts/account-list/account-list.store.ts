import { Injectable, computed, signal } from '@angular/core';

@Injectable()
export class AccountListStore {
  private readonly _selectedIds = signal<ReadonlySet<number>>(new Set());
  private readonly _collapsedPaths = signal<ReadonlySet<string>>(new Set());

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

  toggleCollapsed(path: string): void {
    const next = new Set(this._collapsedPaths());
    if (next.has(path)) {
      next.delete(path);
    } else {
      next.add(path);
    }
    this._collapsedPaths.set(next);
  }

  isCollapsed(path: string): boolean {
    return this._collapsedPaths().has(path);
  }
}
