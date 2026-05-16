import { ChangeDetectionStrategy, Component, inject, input } from '@angular/core';
import { AccountNode } from '../../../../core/accounts.state';
import { AccountListStore } from '../account-list.store';

@Component({
  selector: 'app-account-tree-node',
  imports: [AccountTreeNode],
  templateUrl: './account-tree-node.html',
  styleUrl: './account-tree-node.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AccountTreeNode {
  readonly node = input.required<AccountNode>();
  readonly depth = input<number>(0);

  protected readonly store = inject(AccountListStore);

  protected get indent(): string {
    return `${this.depth() * 1}rem`;
  }
}
