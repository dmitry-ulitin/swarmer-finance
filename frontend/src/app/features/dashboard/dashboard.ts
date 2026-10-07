import { ChangeDetectionStrategy, Component } from '@angular/core';
import { TransactionList } from '../transactions/transaction-list';
import { AccountList } from '../accounts/account-list/account-list';
import { FiltersBar } from '../filters-bar/filters-bar';

@Component({
  selector: 'app-dashboard',
  imports: [FiltersBar, TransactionList, AccountList],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Dashboard {}
