import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { TuiButton, TuiDataList, TuiError, TuiFilterByInputPipe, TuiIcon, TuiInput } from '@taiga-ui/core';
import { TuiChevron, TuiComboBox, TuiDataListWrapper, TuiInputDate, TuiInputNumber, TuiSelect, TuiSegmented, TuiTextarea, TuiTree } from '@taiga-ui/kit';
import { TuiValidationError } from '@taiga-ui/cdk/classes';
import { TuiDay } from '@taiga-ui/cdk/date-time';
import { TuiAutoFocus, type TuiStringHandler } from '@taiga-ui/cdk';
import { POLYMORPHEUS_CONTEXT } from '@taiga-ui/polymorpheus';
import type { TuiDialogContext } from '@taiga-ui/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { TransactionsState } from '../../../core/transactions.state';
import { CategoriesState } from '../../../core/categories.state';
import { AccountsState } from '../../../core/accounts.state';
import { findCategoryById, flattenCategories } from '../../../models/category';
import type { Transaction, TransactionAccount, TransactionCategory } from '../../../models/transaction';
import type { Account } from '../../../models/account';
import type { Category } from '../../../models/category';
import type { CreateTransactionRequest } from '../../../core/api.service';

export interface TransactionFormResult {
  id?: number;
  request: CreateTransactionRequest;
}

@Component({
  selector: 'app-transaction-form',
  imports: [
    ReactiveFormsModule,
    TuiSegmented,
    TuiInput,
    TuiTextarea,
    TuiInputDate,
    TuiInputNumber,
    TuiSelect,
    TuiComboBox,
    TuiDataListWrapper,
    TuiDataList,
    TuiTree,
    TuiIcon,
    TuiFilterByInputPipe,
    TuiChevron,
    TuiButton,
    TuiError,
    TuiAutoFocus
  ],
  templateUrl: './transaction-form.html',
  styleUrl: './transaction-form.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TransactionForm {
  private readonly context = inject<TuiDialogContext<TransactionFormResult | null, Partial<Transaction>>>(POLYMORPHEUS_CONTEXT);
  private readonly transactionsState = inject(TransactionsState);
  protected readonly categoriesState = inject(CategoriesState);
  readonly accountsState = inject(AccountsState);

  readonly stringifyAccount: TuiStringHandler<Account | null> = a => a?.name ?? '';
  readonly accountMatcher = (a: Account | null, b: Account | null): boolean => a?.id === b?.id;
  readonly stringifyCategory: TuiStringHandler<Category | null> = c => c?.fullName ?? c?.name ?? 'Undefined';
  readonly categoryMatcher = (a: Category | null, b: Category | null): boolean => a?.id === b?.id;
  readonly activeTypeIndex = signal(this.context.data.debit_account && this.context.data.credit_account ? 2 : (this.context.data.debit_account ? 0 : 1));

  readonly form = new FormGroup({
    date: new FormControl<TuiDay | null>(this.context.data.date ? TuiDay.fromLocalNativeDate(new Date(this.context.data.date)) : TuiDay.currentLocal(), [Validators.required]),
    fromAccount: new FormControl<TransactionAccount | null>(this.context.data.debit_account ?? null),
    toAccount: new FormControl<TransactionAccount | null>(this.context.data.credit_account ?? null),
    category: new FormControl<TransactionCategory | null>(findCategoryById(this.context.data.category?.id, this.categoriesState.categories()) ?? this.context.data.category ?? null),
    debitCurrency: new FormControl<string>(this.context.data.debit_account?.currency ?? this.context.data.currency ?? '', { nonNullable: true }),
    debitScale: new FormControl<number>(this.context.data.debit_account?.scale ?? this.context.data.scale ?? 2, { nonNullable: true }),
    creditCurrency: new FormControl<string>({ value: this.context.data.credit_account?.currency ?? this.context.data.currency ?? '', disabled: true }, { nonNullable: true }),
    creditScale: new FormControl<number>({ value: this.context.data.credit_account?.scale ?? this.context.data.scale ?? 2, disabled: true }, { nonNullable: true }),
    debitAmount: new FormControl<number | null>(this.context.data.debit ? this.context.data.debit / Math.pow(10, this.context.data.debit_account?.scale ?? this.context.data.scale ?? 2) : null),
    creditAmount: new FormControl<number | null>(this.context.data.credit ? this.context.data.credit / Math.pow(10, this.context.data.credit_account?.scale ?? this.context.data.scale ?? 2) : null),
    description: new FormControl<string>(this.context.data.description ?? '', { nonNullable: true }),
    payee: new FormControl<string>(this.context.data.payee ?? '', { nonNullable: true }),
  });

  readonly error = signal<TuiValidationError | null>(null);

  private readonly fromAccountValue = toSignal(this.form.controls.fromAccount.valueChanges, { initialValue: null });
  private readonly toAccountValue = toSignal(this.form.controls.toAccount.valueChanges, { initialValue: null });
  private readonly debitCurrencyValue = toSignal(this.form.controls.debitCurrency.valueChanges, { initialValue: "" });
  private readonly debitScale = toSignal(this.form.controls.debitScale.valueChanges, { initialValue: 2 });
  private readonly creditCurrencyValue = toSignal(this.form.controls.creditCurrency.valueChanges, { initialValue: "" });
  private readonly creditScale = toSignal(this.form.controls.creditScale.valueChanges, { initialValue: 2 });

  readonly isExpense = computed(() => this.activeTypeIndex() === 0);
  readonly isIncome = computed(() => this.activeTypeIndex() === 1);
  readonly isTransfer = computed(() => this.activeTypeIndex() === 2);

  readonly isSameCurrency = computed(() => {
    const d = this.debitCurrencyValue();
    const c = this.creditCurrencyValue();
    return !!d && d === c;
  });


  readonly debitQuantum = computed(() => 1 / Math.pow(10, this.debitScale()));
  readonly creditQuantum = computed(() => 1 / Math.pow(10, this.creditScale()));

  readonly treeMap = new Map<Category, boolean>();
  readonly treeHandler = computed(() => {
    return (item: Category): readonly Category[] =>
      (item.children || []);
  });
  readonly visibleCategories = computed(() => {
    const rootId = this.isIncome() ? 1 : 2;
    return this.categoriesState.categories().find(c => c.id === rootId)?.children || [];
  });

  constructor() {
    effect(() => {
      const fromAccount = this.fromAccountValue();
      const index = this.activeTypeIndex();

      untracked(() => {
        if (fromAccount) {
          this.form.controls.debitCurrency.setValue(fromAccount?.currency ?? '');
          this.form.controls.debitScale.setValue(fromAccount?.scale ?? 2);
          if (index !== 2) {
            this.form.controls.creditCurrency.setValue(fromAccount?.currency ?? '');
            this.form.controls.creditScale.setValue(fromAccount?.scale ?? 2);
          }
        }
      });
    });
    effect(() => {
      const toAccount = this.toAccountValue();
      const index = this.activeTypeIndex();

      untracked(() => {
        if (toAccount) {
          this.form.controls.creditCurrency.setValue(toAccount?.currency ?? '');
          this.form.controls.creditScale.setValue(toAccount?.scale ?? 2);
          if (index !== 2) {
            this.form.controls.debitCurrency.setValue(toAccount?.currency ?? '');
            this.form.controls.debitScale.setValue(toAccount?.scale ?? 2);
          }
        }
      });
    });
    effect(() => {
      const index = this.activeTypeIndex();
      untracked(() => {
        let fromAccount = this.form.controls.fromAccount.value;
        let toAccount = this.form.controls.toAccount.value;
        if (index === 0) {
          if (!!toAccount) {
            this.form.controls.category.setValue(null);
          }
          this.form.controls.debitCurrency.disable();
          this.form.controls.creditCurrency.enable();
          this.form.controls.toAccount.setValue(null);
          this.form.controls.creditAmount.setValue(this.form.controls.debitAmount.value);
          if (!fromAccount) {
            this.form.controls.fromAccount.setValue(toAccount);
          }
        } else if (index === 1) {
          if (!!fromAccount) {
            this.form.controls.category.setValue(null);
          }
          this.form.controls.debitCurrency.enable();
          this.form.controls.creditCurrency.disable();
          this.form.controls.fromAccount.setValue(null);
          this.form.controls.debitAmount.setValue(this.form.controls.creditAmount.value);
          if (!toAccount) {
            this.form.controls.toAccount.setValue(fromAccount);
          }
        } else {
          this.form.controls.debitCurrency.disable();
          this.form.controls.creditCurrency.disable();
          if (!!fromAccount) {
            toAccount = this.transactionsState.transactions().filter(t => t.debit_account?.id === fromAccount!.id && !!t.credit_account)[0]?.credit_account ||
              this.accountsState.accounts().filter(a => a.id !== fromAccount!.id && a.currency === fromAccount!.currency)[0] ||
              this.accountsState.accounts().filter(a => a.id !== fromAccount!.id)[0];
            this.form.controls.toAccount.setValue(toAccount ?? null);
          } else if (!!toAccount) {
            fromAccount = this.transactionsState.transactions().filter(t => t.credit_account?.id === toAccount!.id && !!t.debit_account)[0]?.debit_account ||
              this.accountsState.accounts().filter(a => a.id !== toAccount!.id && a.currency === toAccount!.currency)[0] ||
              this.accountsState.accounts().filter(a => a.id !== toAccount!.id)[0];
            this.form.controls.fromAccount.setValue(fromAccount ?? null);
          }
        }
      });
    });
  }

  cancel(): void {
    this.context.completeWith(null);
  }

  onSubmit(): void {
    let { date, fromAccount, toAccount, category, debitAmount, creditAmount, description, payee } = this.form.getRawValue();

    if (!date) {
      this.error.set(new TuiValidationError('Date is required'));
      return;
    }

    const isExpense = this.isExpense();
    const isIncome = this.isIncome();
    if (this.isSameCurrency()) {
      if (isExpense) {
        debitAmount = creditAmount ?? debitAmount;
      } else {
        creditAmount = debitAmount ?? creditAmount;
      }
    }

    if (debitAmount == null || debitAmount <= 0) {
      this.error.set(new TuiValidationError('Debit amount is required'));
      return;
    }
    if (creditAmount == null || creditAmount <= 0) {
      this.error.set(new TuiValidationError('Credit amount is required'));
      return;
    }

    const dScale = this.debitScale();
    const cScale = this.creditScale();
    const debitCents = Math.round(debitAmount * Math.pow(10, dScale));
    const creditRaw = this.isSameCurrency() ? debitAmount : (creditAmount ?? debitAmount);
    const creditCents = Math.round(creditRaw * Math.pow(10, cScale));

    let request: CreateTransactionRequest;

    if (isExpense) {
      request = {
        debitAccountId: fromAccount!.id,
        creditAccountId: null,
        debit: debitCents,
        credit: creditCents,
        currency: this.creditCurrencyValue() || null,
        scale: cScale,
        categoryId: category?.id ?? null,
        date: date.toJSON(),
        description: description || null,
        payee: payee || null,
      };
    } else if (isIncome) {
      request = {
        debitAccountId: null,
        creditAccountId: toAccount!.id,
        debit: debitCents,
        credit: creditCents,
        currency: this.debitCurrencyValue() || null,
        scale: dScale,
        categoryId: category?.id ?? null,
        date: date.toJSON(),
        description: description || null,
        payee: payee || null,
      };
    } else {
      request = {
        debitAccountId: fromAccount!.id,
        creditAccountId: toAccount!.id,
        debit: debitCents,
        credit: creditCents,
        currency: null,
        scale: null,
        categoryId: null,
        date: date.toJSON(),
        description: description || null,
        payee: payee || null,
      };
    }

    this.context.completeWith({ id: this.context.data.id, request });
  }
}
