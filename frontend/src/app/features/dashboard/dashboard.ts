import { ChangeDetectionStrategy, Component } from '@angular/core';
import { TransactionList } from '../transactions/transaction-list';

@Component({
  selector: 'app-dashboard',
  imports: [TransactionList],
  templateUrl: './dashboard.html',
  styleUrl: './dashboard.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class Dashboard {}
