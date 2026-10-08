import { ChangeDetectionStrategy, Component } from '@angular/core';
import { TransactionList } from '../transactions/transaction-list';
import { AccountList } from '../accounts/account-list/account-list';
import { FiltersBar } from '../filters-bar/filters-bar';
import { CategorySummaryPanel } from '../category-summary/category-summary';

@Component({
  selector: 'app-dashboard',
  imports: [FiltersBar, TransactionList, AccountList, CategorySummaryPanel],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Dashboard {}
