import { ChangeDetectionStrategy, Component } from '@angular/core';
import { TransactionList } from '../transactions/transaction-list';
import { AccountList } from '../accounts/account-list/account-list';

@Component({
  selector: 'app-dashboard',
  imports: [TransactionList, AccountList],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Dashboard {}
