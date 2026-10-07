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
import { ADDRESS_EXPLORERS, TX_EXPLORERS, type Account } from '../../../models/account';
import type { Category } from '../../../models/category';
import type { TransactionRequest } from '../../../core/api.service';
import { NotificationService } from '../../../core/notification.service';
import { CategorySelect } from '../../categories/category-select/category-select';
import { CategoryDialogService } from '../../categories/category-dialog.service';
import { syncedLock } from '../synced-lock';

/** The type selector's segments, in order: Expense, Income, Transfer. */
const TYPE_ORDER = [TransactionType.Expense, TransactionType.Income, TransactionType.Transfer] as const;
type FormType = (typeof TYPE_ORDER)[number];
type AccountSide = 'debit_account' | 'credit_account';

/** Shortens a hash or address to its head and tail. */
function shorten(s: string): string {
  return `${s.slice(0, 10)}…${s.slice(-8)}`;
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
  private readonly transactionsState = inject(TransactionsState);
  private readonly categoriesState = inject(CategoriesState);
  private readonly categoryDialogs = inject(CategoryDialogService);
  readonly accountsState = inject(AccountsState);

  private readonly data = this.context.data;

  readonly stringifyAccount: TuiStringHandler<Account | null> = a => a?.name ?? '';
  readonly accountMatcher = (a: Account | null, b: Account | null): boolean => a?.id === b?.id;
  readonly lock = syncedLock(this.data, this.accountsState.trackedIds());
  /** Network fees are written by sync only: neither category nor type can change. */
  readonly isNetworkFee = this.data.category?.id === TransactionType.NetworkFees;

  readonly activeTypeIndex = signal(TYPE_ORDER.indexOf(
    this.data.debit_account && this.data.credit_account ? TransactionType.Transfer
      : this.data.debit_account ? TransactionType.Expense
      : TransactionType.Income
  ));
  private readonly type = computed<FormType>(() => TYPE_ORDER[this.activeTypeIndex()]);
  readonly isExpense = computed(() => this.type() === TransactionType.Expense);
  readonly isIncome = computed(() => this.type() === TransactionType.Income);
  readonly isTransfer = computed(() => this.type() === TransactionType.Transfer);
  /** 1 = Income, 2 = Expenses; drives which branch the picker offers. */
  readonly categoryRootId = computed(() => (this.isIncome() ? TransactionType.Income : TransactionType.Expense));
  readonly uncategorized = computed(() => {
    const id = this.isIncome() ? TransactionType.UncategorizedIncome : TransactionType.UncategorizedExpense;
    const root = this.categoriesState.categories().find(c => c.id === this.categoryRootId());
    return root?.children?.find(c => c.id === id) ?? null;
  });

  readonly form = new FormGroup({
    date: new FormControl<TuiDay | null>(this.data.date ? TuiDay.jsonParse(this.data.date) : TuiDay.currentLocal(), [Validators.required]),
    fromAccount: new FormControl<TransactionAccount | null>(this.data.debit_account ?? null),
    toAccount: new FormControl<TransactionAccount | null>(this.data.credit_account ?? null),
    // The transaction's own category is the starting value, falling back to
    // the tree only to pick a default for a brand-new transaction. It may
    // belong to another user (a shared account's transaction), in which case
    // it is not in this user's own branch of the tree — using it directly
    // keeps it visible instead of silently resetting to the first category.
    category: new FormControl<Category | null>(
      this.data.category ?? this.uncategorized(),
      { nonNullable: true }
    ),
    debitAmount: new FormControl<number | null>(this.data.debit || null),
    creditAmount: new FormControl<number | null>(this.data.credit || null),
    description: new FormControl<string>(this.data.description ?? '', { nonNullable: true }),
    payee: new FormControl<string>(this.data.payee ?? '', { nonNullable: true }),
  });

  readonly fromAccountValue = toSignal(this.form.controls.fromAccount.valueChanges, { initialValue: this.form.controls.fromAccount.value });
  readonly toAccountValue = toSignal(this.form.controls.toAccount.valueChanges, { initialValue: this.form.controls.toAccount.value });

  /** Synced accounts are never picked by hand: sync alone writes to them. */
  readonly accountOptions = computed(() => {
    const tracked = this.accountsState.trackedIds();
    return this.accountsState.accounts().filter(a => !tracked.has(a.id));
  });

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

  /** The blockchain of the row's synced side, when its account is loaded. */
  private readonly chain = computed(() => {
    const sides = [this.data.debit_account?.id, this.data.credit_account?.id];
    const tracked = this.accountsState.trackedIds();
    return this.accountsState.accounts()
      .flatMap(a => (a.type === 'crypto' && sides.includes(a.id) && tracked.has(a.id) ? [a.settings.blockchain] : []))
      .find(b => b !== undefined && b in TX_EXPLORERS);
  });
  /** The on-chain transaction of a synced row, linked to its chain's explorer when that is known. */
  readonly chainTx = computed(() => {
    const { txid } = this.data;
    if (!txid) return null;
    const chain = this.chain();
    return { txid, short: shorten(txid), url: chain ? TX_EXPLORERS[chain](txid) : null };
  });
  /** The counterparty address the chain wrote as a synced row's payee, linked to its explorer page. */
  readonly chainPayee = computed(() => {
    const { payee } = this.data;
    if (!this.lock.synced || !payee) return null;
    const chain = this.chain();
    return {
      value: payee,
      short: payee.length > 20 ? shorten(payee) : payee,
      url: chain ? ADDRESS_EXPLORERS[chain](payee) : null,
    };
  });

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
    if (this.isNetworkFee) {
      c.category.disable();
    }

    effect(() => {
      const type = this.type();
      untracked(() => this.applyType(type));
    });
  }

  /** 0 Expense, 1 Income, 2 Transfer. A locked side must stay filled. */
  typeAllowed(index: 0 | 1 | 2): boolean {
    const type = TYPE_ORDER[index];
    if (this.isNetworkFee) return type === TransactionType.Expense;
    const { debitLocked, creditLocked } = this.lock;
    if (debitLocked && creditLocked) return false;
    if (debitLocked) return type !== TransactionType.Income;
    if (creditLocked) return type !== TransactionType.Expense;
    return true;
  }

  /** Moves the date by `days`, counting from today when it is empty. */
  shiftDate(days: number): void {
    const c = this.form.controls.date;
    c.setValue((c.value ?? TuiDay.currentLocal()).append({ day: days }));
  }

  setToday(): void {
    this.form.controls.date.setValue(TuiDay.currentLocal());
  }

  async copy(value: string, what: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      this.notifications.showSuccess(`${what[0].toUpperCase()}${what.slice(1)} copied`);
    } catch (err) {
      this.notifications.showError(err, `Could not copy the ${what}`);
    }
  }

  /** Creates a category in the current type's branch and selects it. */
  async addCategory(): Promise<void> {
    const category = await this.categoryDialogs.openCreate(null, this.categoryRootId());
    if (category) {
      this.form.controls.category.setValue(category);
    }
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

    const request: TransactionRequest = {
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

  /** Reshapes the form for a newly selected type, carrying over what still fits. */
  private applyType(type: FormType): void {
    const c = this.form.controls;
    const fromAccount = c.fromAccount.value;
    const toAccount = c.toAccount.value;
    const category = c.category.value;
    switch (type) {
      case TransactionType.Expense:
        if (category?.root_id !== TransactionType.Expense) {
          c.category.setValue(this.uncategorized());
        }
        c.toAccount.setValue(null);
        c.creditAmount.setValue(c.debitAmount.value);
        if (!fromAccount) {
          c.fromAccount.setValue(toAccount);
        }
        break;
      case TransactionType.Income:
        if (category?.root_id !== TransactionType.Income) {
          c.category.setValue(this.uncategorized());
        }
        c.fromAccount.setValue(null);
        c.debitAmount.setValue(c.creditAmount.value);
        if (!toAccount) {
          c.toAccount.setValue(fromAccount);
        }
        break;
      case TransactionType.Transfer:
        if (fromAccount) {
          c.toAccount.setValue(this.transferPeer(fromAccount, 'debit_account'));
        } else if (toAccount) {
          c.fromAccount.setValue(this.transferPeer(toAccount, 'credit_account'));
        }
        break;
    }
  }

  /**
   * The likely other side of a transfer where `account` is on side `own`: the
   * last untracked account it was paired with, else another account in its
   * currency, else any other account.
   */
  private transferPeer(account: TransactionAccount, own: AccountSide): TransactionAccount | null {
    const other: AccountSide = own === 'debit_account' ? 'credit_account' : 'debit_account';
    const tracked = this.accountsState.trackedIds();
    const recent = this.transactionsState.transactions()
      .find(t => t[own]?.id === account.id && !!t[other] && !tracked.has(t[other].id))?.[other];
    const others = this.accountOptions().filter(a => a.id !== account.id);
    return recent ?? others.find(a => a.currency === account.currency) ?? others[0] ?? null;
  }
}
