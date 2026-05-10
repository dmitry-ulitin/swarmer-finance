import { ChangeDetectionStrategy, Component, computed, effect, inject, signal } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { TuiButton, TuiDataList, TuiDropdown, TuiError, TuiFilterByInputPipe, TuiInput } from '@taiga-ui/core';
import { TuiChevron, TuiComboBox, TuiDataListWrapper, TuiSelect } from '@taiga-ui/kit';
import { TuiValidationError } from '@taiga-ui/cdk/classes';
import type { TuiStringHandler } from '@taiga-ui/cdk';
import { POLYMORPHEUS_CONTEXT } from '@taiga-ui/polymorpheus';
import type { TuiDialogContext } from '@taiga-ui/core';
import { firstValueFrom } from 'rxjs';
import { toSignal } from '@angular/core/rxjs-interop';
import { AccountsState } from '../../../core/accounts.state';
import { CategoriesState } from '../../../core/categories.state';
import { TransactionsState } from '../../../core/transactions.state';
import { flattenCategories } from '../../../models/category';
import type { Category } from '../../../models/category';
import type { Account } from '../../../models/account';
import type { Transaction, TransactionKind } from '../../../models/transaction';

@Component({
  selector: 'app-transaction-form',
  imports: [ReactiveFormsModule, TuiInput, TuiButton, TuiError, TuiDataList, TuiDropdown, TuiSelect, TuiChevron, TuiComboBox, TuiDataListWrapper, TuiFilterByInputPipe],
  templateUrl: './transaction-form.html',
  styleUrl: './transaction-form.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TransactionForm {
  private readonly context = inject<TuiDialogContext<Transaction | null, null>>(POLYMORPHEUS_CONTEXT);
  private readonly accountsState = inject(AccountsState);
  private readonly categoriesState = inject(CategoriesState);
  private readonly transactionsState = inject(TransactionsState);

  readonly type = signal<TransactionKind>('expense');
  readonly loading = signal(false);
  readonly error = signal<TuiValidationError | null>(null);

  readonly accounts = this.accountsState.accounts;
  readonly currencies = this.accountsState.currencies;

  readonly categories = computed(() => {
    const rootId = this.type() === 'income' ? 1 : 2;
    return flattenCategories(this.categoriesState.categories())
      .filter(c => c.root_id === rootId && !c.children?.length);
  });

  readonly form = new FormGroup({
    date: new FormControl<string>(new Date().toISOString().split('T')[0], { nonNullable: true, validators: [Validators.required] }),
    debitAccountId: new FormControl<Account | null>(null),
    creditAccountId: new FormControl<Account | null>(null),
    categoryId: new FormControl<Category | null>(null),
    currency: new FormControl<string>(this.accountsState.currencies()[0] ?? '', { nonNullable: true }),
    amount: new FormControl<number | null>(null),
    creditAmount: new FormControl<number | null>(null),
    description: new FormControl<string>('', { nonNullable: true }),
    payee: new FormControl<string>('', { nonNullable: true }),
  });

  private readonly debitAccount = toSignal(this.form.controls.debitAccountId.valueChanges);
  private readonly creditAccount = toSignal(this.form.controls.creditAccountId.valueChanges);

  constructor() {
    effect(() => {
      const account = this.debitAccount();
      if (account && this.type() === 'expense') {
        this.form.controls.currency.setValue(account.currency, { emitEvent: false });
      }
    });
    effect(() => {
      const account = this.creditAccount();
      if (account && this.type() === 'income') {
        this.form.controls.currency.setValue(account.currency, { emitEvent: false });
      }
    });
  }

  readonly stringifyAccount: TuiStringHandler<Account | null> = (a) => a?.name ?? '';
  readonly stringifyCategory: TuiStringHandler<Category | null> = (c) => c?.fullName ?? '';
  readonly identityMatcherAccount = (a: Account | null, b: Account | null) => a?.id === b?.id;
  readonly identityMatcherCategory = (a: Category | null, b: Category | null) => a?.id === b?.id;

  setType(type: TransactionKind): void {
    this.type.set(type);
    this.form.controls.debitAccountId.reset(null);
    this.form.controls.creditAccountId.reset(null);
    this.form.controls.categoryId.reset(null);
    this.form.controls.currency.setValue(this.accountsState.currencies()[0] ?? '');
    this.error.set(null);
  }

  cancel(): void {
    this.context.completeWith(null);
  }

  async onSubmit(): Promise<void> {
    const { date, debitAccountId, creditAccountId, categoryId, currency, amount, creditAmount, description, payee } = this.form.getRawValue();
    const type = this.type();

    if (!date) { this.error.set(new TuiValidationError('Date is required')); return; }
    if (type !== 'income' && (!debitAccountId || amount == null)) { this.error.set(new TuiValidationError('Account and amount are required')); return; }
    if (type !== 'expense' && (!creditAccountId || amount == null)) { this.error.set(new TuiValidationError('Account and amount are required')); return; }
    if (type !== 'transfer' && !categoryId) { this.error.set(new TuiValidationError('Category is required')); return; }

    try {
      this.loading.set(true);
      this.error.set(null);

      const debitCents = Math.round((amount ?? 0) * 100);
      const creditCents = creditAmount != null ? Math.round(creditAmount * 100) : debitCents;

      const request = {
        date,
        debit: debitCents,
        credit: creditCents,
        description: description || undefined,
        payee: payee || undefined,
        ...(type === 'expense' && {
          debitAccountId: debitAccountId!.id,
          categoryId: categoryId!.id,
          currency: currency || debitAccountId!.currency,
          scale: 2,
        }),
        ...(type === 'income' && {
          creditAccountId: creditAccountId!.id,
          categoryId: categoryId!.id,
          currency: currency || creditAccountId!.currency,
          scale: 2,
        }),
        ...(type === 'transfer' && {
          debitAccountId: debitAccountId!.id,
          creditAccountId: creditAccountId!.id,
        }),
      };

      const response = await firstValueFrom(this.transactionsState.create(request));
      this.context.completeWith(response.data);
    } catch {
      this.error.set(new TuiValidationError('Failed to save transaction'));
    } finally {
      this.loading.set(false);
    }
  }
}
