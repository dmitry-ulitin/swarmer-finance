import { ChangeDetectionStrategy, Component, computed, inject, output, signal } from '@angular/core';
import { AccountsState } from '../../../core/accounts.state';

@Component({
  selector: 'app-account-list',
  templateUrl: './account-list.html',
  styleUrl: './account-list.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AccountList {
  readonly selectionChange = output<number[]>();

  protected readonly state = inject(AccountsState);
  protected readonly selectedIds = signal<ReadonlySet<number>>(new Set());
  protected readonly collapsedGroups = signal<ReadonlySet<string>>(new Set());

  protected readonly isAllSelected = computed(() => this.selectedIds().size === 0);

  selectAll(): void {
    this.selectedIds.set(new Set());
    this.selectionChange.emit([]);
  }

  toggleAccount(id: number): void {
    const current = new Set(this.selectedIds());
    if (current.has(id)) {
      current.delete(id);
    } else {
      current.add(id);
    }
    this.selectedIds.set(current);
    this.selectionChange.emit([...current]);
  }

  toggleGroup(groupName: string): void {
    const current = new Set(this.collapsedGroups());
    if (current.has(groupName)) {
      current.delete(groupName);
    } else {
      current.add(groupName);
    }
    this.collapsedGroups.set(current);
  }

  isCollapsed(groupName: string): boolean {
    return this.collapsedGroups().has(groupName);
  }

  isSelected(id: number): boolean {
    return this.selectedIds().has(id);
  }
}
