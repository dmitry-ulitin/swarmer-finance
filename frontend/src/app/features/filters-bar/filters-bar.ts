import { ChangeDetectionStrategy, Component, inject } from '@angular/core';
import { takeUntilDestroyed } from '@angular/core/rxjs-interop';
import { FormControl, ReactiveFormsModule } from '@angular/forms';
import { TuiIcon, TuiInput } from '@taiga-ui/core';
import { debounceTime, distinctUntilChanged, map } from 'rxjs';
import { TransactionsState } from '../../core/transactions.state';

@Component({
  selector: 'app-filters-bar',
  imports: [ReactiveFormsModule, TuiIcon, TuiInput],
  templateUrl: './filters-bar.html',
  styles: `
    :host { display: flex; gap: 1rem; }
    .search { width: 20rem; max-width: 100%; }
  `,
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class FiltersBar {
  private readonly transactions = inject(TransactionsState);
  protected readonly details = new FormControl('', { nonNullable: true });

  constructor() {
    this.details.valueChanges.pipe(
      debounceTime(300),
      map(value => value.trim() || undefined),
      distinctUntilChanged(),
      takeUntilDestroyed(),
    ).subscribe(details => this.transactions.setDetails(details));
  }
}
