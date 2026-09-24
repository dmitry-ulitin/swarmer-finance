import { ChangeDetectionStrategy, Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { TuiButton, TuiDataList, TuiInput, TuiNumberFormat } from '@taiga-ui/core';
import { TuiChevron, TuiComboBox, TuiDataListWrapper, TuiInputDate, TuiInputNumber, TuiSelect, TuiSegmented, TuiTextarea } from '@taiga-ui/kit';
import { TuiDay } from '@taiga-ui/cdk/date-time';
import { TuiAutoFocus, type TuiStringHandler } from '@taiga-ui/cdk';
import { POLYMORPHEUS_CONTEXT } from '@taiga-ui/polymorpheus';
import type { TuiDialogContext } from '@taiga-ui/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { TransactionsState } from '../../../core/transactions.state';
import { CategoriesState } from '../../../core/categories.state';
import { AccountsState } from '../../../core/accounts.state';
import { TransactionType, type Transaction, type TransactionAccount } from '../../../models/transaction';
import type { Account } from '../../../models/account';
import type { Category } from '../../../models/category';
import type { TransactionRequest } from '../../../core/api.service';
import { NotificationService } from '../../../core/notification.service';
import { AuthService } from '../../../core/auth.service';
import { CategorySelect } from '../../categories/category-select/category-select';
import { syncedLock } from '../synced-lock';

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
    TuiChevron,
    TuiButton,
    TuiAutoFocus,
    TuiNumberFormat,
    CategorySelect
  ],
  templateUrl: './transaction-form.html',
  styleUrl: './transaction-form.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class TransactionForm {
  private readonly context = inject<TuiDialogContext<TransactionRequest | null, Partial<Transaction>>>(POLYMORPHEUS_CONTEXT);
  private readonly notifications = inject(NotificationService);
  private readonly auth = inject(AuthService);
  private readonly transactionsState = inject(TransactionsState);
  protected readonly categoriesState = inject(CategoriesState);
  readonly accountsState = inject(AccountsState);

  readonly stringifyAccount: TuiStringHandler<Account | null> = a => a?.name ?? '';
  readonly accountMatcher = (a: Account | null, b: Account | null): boolean => a?.id === b?.id;
  readonly lock = syncedLock(this.context.data, this.accountsState.trackedIds());
  /** Synced accounts are never picked by hand: sync alone writes to them. */
  readonly accountOptions = computed(() => {
    const tracked = this.accountsState.trackedIds();
    return this.accountsState.accounts().filter(a => !tracked.has(a.id));
  });
  readonly activeTypeIndex = signal(this.context.data.debit_account && this.context.data.credit_account ? 2 : (this.context.data.debit_account ? 0 : 1));
  readonly isExpense = computed(() => this.activeTypeIndex() === 0);
  readonly isIncome = computed(() => this.activeTypeIndex() === 1);
  readonly isTransfer = computed(() => this.activeTypeIndex() === 2);
  /** 1 = Income, 2 = Expenses; drives which branch the picker offers. */
  readonly categoryRootId = computed(() => (this.isIncome() ? 1 : 2));
  readonly visibleCategories = computed(
    () => this.categoriesState.categories().find(c => c.id === this.categoryRootId())?.children || []
  );

  readonly form = new FormGroup({
    date: new FormControl<TuiDay | null>(this.context.data.date ? TuiDay.jsonParse(this.context.data.date) : TuiDay.currentLocal(), [Validators.required]),
    fromAccount: new FormControl<TransactionAccount | null>(this.context.data.debit_account ?? null),
    toAccount: new FormControl<TransactionAccount | null>(this.context.data.credit_account ?? null),
    // The transaction's own category is the starting value, falling back to
    // the tree only to pick a default for a brand-new transaction. It may
    // belong to another user (a shared account's transaction), in which case
    // it is not in this user's own branch of the tree — using it directly
    // keeps it visible instead of silently resetting to the first category.
    category: new FormControl<Category | null>(
      this.context.data.category ?? this.visibleCategories()[0],
      { nonNullable: true }
    ),
    debitAmount: new FormControl<number | null>(this.context.data.debit ? this.context.data.debit : null),
    creditAmount: new FormControl<number | null>(this.context.data.credit ? this.context.data.credit : null),
    description: new FormControl<string>(this.context.data.description ?? '', { nonNullable: true }),
    payee: new FormControl<string>(this.context.data.payee ?? '', { nonNullable: true }),
  });

  readonly fromAccountValue = toSignal(this.form.controls.fromAccount.valueChanges, { initialValue: this.context.data.debit_account ?? null });
  readonly toAccountValue = toSignal(this.form.controls.toAccount.valueChanges, { initialValue: this.context.data.credit_account ?? null });

  readonly isSameCurrency = computed(() => {
    const d = this.fromAccountValue()?.currency;
    const c = this.toAccountValue()?.currency;
    return !this.isTransfer() || (!!d && d === c);
  });


  // Each amount is entered at its own account's scale; the input would
  // otherwise round to 2 decimals and show 0.00146435 BTC as 0.
  readonly debitPrecision = computed(() => this.fromAccountValue()?.scale ?? 2);
  readonly creditPrecision = computed(() => this.toAccountValue()?.scale ?? 2);
  readonly debitQuantum = computed(() => 1 / Math.pow(10, this.debitPrecision()));
  readonly creditQuantum = computed(() => 1 / Math.pow(10, this.creditPrecision()));

  constructor() {
    const c = this.form.controls;
    if (this.lock.synced) {
      c.date.disable();
      c.payee.disable();
    }
    if (this.lock.debitLocked) {
      c.fromAccount.disable();
      c.debitAmount.disable();
    }
    if (this.lock.creditLocked) {
      c.toAccount.disable();
      c.creditAmount.disable();
    }

    effect(() => {
      const index = this.activeTypeIndex();
      untracked(() => {
        let fromAccount = this.form.controls.fromAccount.value;
        let toAccount = this.form.controls.toAccount.value;
        let category = this.form.controls.category.value;
        if (index === 0) {
          if (category?.root_id !== TransactionType.Expense) {
            this.form.controls.category.setValue(this.visibleCategories()[0]);
          }
          this.form.controls.toAccount.setValue(null);
          this.form.controls.creditAmount.setValue(this.form.controls.debitAmount.value);
          if (!fromAccount) {
            this.form.controls.fromAccount.setValue(toAccount);
          }
        } else if (index === 1) {
          if (category?.root_id !== TransactionType.Income) {
            this.form.controls.category.setValue(this.visibleCategories()[0]);
          } 
          this.form.controls.fromAccount.setValue(null);
          this.form.controls.debitAmount.setValue(this.form.controls.creditAmount.value);
          if (!toAccount) {
            this.form.controls.toAccount.setValue(fromAccount);
          }
        } else {
          const tracked = this.accountsState.trackedIds();
          if (!!fromAccount) {
            toAccount = this.transactionsState.transactions().filter(t => t.debit_account?.id === fromAccount!.id && !!t.credit_account && !tracked.has(t.credit_account.id))[0]?.credit_account ||
              this.accountOptions().filter(a => a.id !== fromAccount!.id && a.currency === fromAccount!.currency)[0] ||
              this.accountOptions().filter(a => a.id !== fromAccount!.id)[0];
            this.form.controls.toAccount.setValue(toAccount ?? null);
          } else if (!!toAccount) {
            fromAccount = this.transactionsState.transactions().filter(t => t.credit_account?.id === toAccount!.id && !!t.debit_account && !tracked.has(t.debit_account.id))[0]?.debit_account ||
              this.accountOptions().filter(a => a.id !== toAccount!.id && a.currency === toAccount!.currency)[0] ||
              this.accountOptions().filter(a => a.id !== toAccount!.id)[0];
            this.form.controls.fromAccount.setValue(fromAccount ?? null);
          }
        }
      });
    });
  }

  /** 0 Expense, 1 Income, 2 Transfer. A locked side must stay filled. */
  typeAllowed(index: 0 | 1 | 2): boolean {
    const { debitLocked, creditLocked } = this.lock;
    if (debitLocked && creditLocked) return false;
    if (debitLocked) return index !== 1;
    if (creditLocked) return index !== 0;
    return true;
  }

  cancel(): void {
    this.context.completeWith(null);
  }

  onSubmit(): void {
    let { date, fromAccount, toAccount, category, debitAmount, creditAmount, description, payee } = this.form.getRawValue();

    if (!date) {
      this.notifications.showError('Date is required');
      return;
    }

    if (this.isSameCurrency()) {
      debitAmount = creditAmount = creditAmount ?? debitAmount;
    }
    if (debitAmount == null || debitAmount <= 0 || creditAmount == null || creditAmount <= 0) {
      this.notifications.showError('Debit and credit amounts are required');
      return;
    }

    let request: TransactionRequest = {
        debitAccountId: this.isIncome() ? null : fromAccount!.id,
        creditAccountId: this.isExpense() ? null : toAccount!.id,
        debit: debitAmount,
        credit: creditAmount,
        categoryId: this.isTransfer() ? null : category?.id ?? null,
        date: date.toJSON(), 
        description: description || null,
        payee: payee || null,
      };
    this.context.completeWith(request);
  }
}
