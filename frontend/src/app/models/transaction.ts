import type { Category } from './category';

export interface TransactionAccount {
    id: number;
    name: string;
    currency: string;
    scale: number;
    balance?: number;
}

export interface Transaction {
    id: number;
    user_id: number;
    category: Category | null;
    debit_account: TransactionAccount | null;
    credit_account: TransactionAccount | null;
    debit: number;
    credit: number;
    currency: string | null;
    scale: number | null;
    date: string;
    description: string;
    payee: string | null;
    /** The on-chain transaction a synced row came from, else null. */
    txid: string | null;
    created_at: string;
}

export interface TransactionFilters {
    from?: string;
    to?: string;
    categories?: number[];
    accounts?: number[];
    details?: string;
    type?: 'income' | 'expense' | 'transfer';
}

/** One top-level category's income or expense, subcategories included. */
export interface CategorySummaryItem {
    category_id: number;
    name: string;
    color: string;
    icon: string;
    /** In the user's currency; null when an exchange rate is missing. */
    total: number | null;
    /** The unconverted sums, one per account currency. */
    amounts: { currency: string; scale: number; amount: number }[];
}

export interface CategorySummary {
    currency: string;
    scale: number;
    income: CategorySummaryItem[];
    expense: CategorySummaryItem[];
}

export enum TransactionType {
    Transfer = 0,
    Income,
    Expense,
    UncategorizedIncome,
    UncategorizedExpense,
    NetworkFees
}

export interface TransactionView extends Transaction {
    accountName: string;
    amount: number;
    amountCurrency: string;
    amountScale: number;
    balance: number | null;
    balanceCurrency: string;
    balanceScale: number;
    type: TransactionType;
}

export function getTransactionType(t: Transaction): TransactionType {
    if (t.debit_account != null && t.credit_account != null) return TransactionType.Transfer;
    if (t.debit_account != null) return TransactionType.Expense;
    return TransactionType.Income;
}
