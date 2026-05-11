import { ChangeDetectionStrategy, Component, DestroyRef, ElementRef, afterNextRender, inject, viewChild } from '@angular/core';
import { DatePipe } from '@angular/common';
import { TransactionsState } from '../../core/transactions.state';
import { Transaction, getTransactionKind } from '../../models/transaction';
import { TuiButton, TuiLoader } from '@taiga-ui/core';

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

  protected accountName(t: Transaction): string {
    const kind = getTransactionKind(t);
    if (kind === 'expense') return t.debit_account?.name ?? '';
    if (kind === 'income') return t.credit_account?.name ?? '';
    return `${t.debit_account?.name ?? '?'} → ${t.credit_account?.name ?? '?'}`;
  }

  protected amount(t: Transaction): string {
    const scale = t.scale ?? 2;
    const divisor = Math.pow(10, scale);
    const kind = getTransactionKind(t);

    if (kind === 'transfer') {
      const val = t.debit / divisor;
      return `${val.toLocaleString()} ${t.debit_account?.currency ?? ''}`;
    }

    const raw = kind === 'income' ? t.debit : t.credit;
    const val = raw / divisor;
    const sign = kind === 'income' ? '+' : '−';
    return `${sign}${val.toLocaleString()} ${t.currency ?? ''}`;
  }

  protected kind(t: Transaction) {
    return getTransactionKind(t);
  }
}
