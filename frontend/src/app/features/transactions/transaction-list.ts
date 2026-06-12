import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, afterNextRender, inject, viewChild } from '@angular/core';
import { DatePipe } from '@angular/common';
import { TransactionsState } from '../../core/transactions.state';
import { TuiButton, TuiLoader } from '@taiga-ui/core';
import type { TransactionView } from '../../models/transaction';

@Component({
  selector: 'app-transaction-list',
  imports: [TuiLoader, TuiButton, DatePipe],
  templateUrl: './transaction-list.html',
  styleUrl: './transaction-list.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TransactionList {
  readonly state = inject(TransactionsState);
  private readonly destroyRef = inject(DestroyRef);
  private readonly sentinel = viewChild.required<ElementRef<HTMLElement>>('sentinel');

  selectTransaction(t: TransactionView): void {
    this.state.selectTransaction(t);
  }

  constructor() {
    afterNextRender(() => {
      this.state.reload();

      const observer = new IntersectionObserver(
        entries => { if (entries[0].isIntersecting) this.state.loadMore(); },
        { rootMargin: '0px 0px 400px 0px' }
      );
      observer.observe(this.sentinel().nativeElement);
      this.destroyRef.onDestroy(() => observer.disconnect());
    });
  }
}
