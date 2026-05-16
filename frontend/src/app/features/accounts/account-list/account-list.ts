import { ChangeDetectionStrategy, Component, effect, inject, output } from '@angular/core';
import { AccountsState } from '../../../core/accounts.state';
import { AccountListStore } from './account-list.store';
import { AccountTreeNode } from './account-tree-node/account-tree-node';

@Component({
  selector: 'app-account-list',
  imports: [AccountTreeNode],
  providers: [AccountListStore],
  templateUrl: './account-list.html',
  styleUrl: './account-list.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AccountList {
  readonly selectionChange = output<number[]>();

  protected readonly state = inject(AccountsState);
  protected readonly store = inject(AccountListStore);

  constructor() {
    effect(() => {
      this.selectionChange.emit(this.store.selectedIdsArray());
    });
  }
}
