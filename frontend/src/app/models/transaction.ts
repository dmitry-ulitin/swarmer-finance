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
    /** `transfer_in` / `transfer_out`: credited to / debited from the selected accounts. */
    type?: 'income' | 'expense' | 'transfer' | 'transfer_in' | 'transfer_out';
}

/** What a CSV export of the current filters would hold. */
export interface ExportPreview {
    rows: number;
    accounts: number;
    from: string | null;
    to: string | null;
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

/** One direction of transfers, seen from the selected accounts. */
export interface TransferSideSummary {
    /** In the user's currency; null when an exchange rate is missing. */
    total: number | null;
    /** The unconverted sums, one per account currency. */
    amounts: CategorySummaryItem['amounts'];
}

export interface CategorySummary {
    currency: string;
    scale: number;
    income: CategorySummaryItem[];
    expense: CategorySummaryItem[];
    transfers: {
        /** `in` minus `out`; null when an exchange rate is missing. */
        net: number | null;
        in: TransferSideSummary;
        out: TransferSideSummary;
    };
}

export enum TransactionType {
    Transfer = 0,
    Income,
    Expense,
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
