export enum TransactionType {
    Transfer = 0,
    Income,
    Expense,
    Correction
}

export interface TransactionCategory {
    id: number;
    name: string;
    color: string;
}

export interface TransactionAccount {
    id: number;
    name: string;
    currency: string;
    scale: number;
}

export interface Transaction {
    id: number;
    user_id: number;
    category: TransactionCategory | null;
    debit_account: TransactionAccount | null;
    credit_account: TransactionAccount | null;
    debit: number;
    credit: number;
    currency: string | null;
    scale: number | null;
    date: string;
    description: string;
    payee: string | null;
    created_at: string;
}

export interface TransactionFilters {
    from?: string;
    to?: string;
    category?: number[];
    account?: number[];
    details?: string;
    type?: 'income' | 'expense' | 'transfer';
}

export type TransactionKind = 'expense' | 'income' | 'transfer';

export function getTransactionKind(t: Transaction): TransactionKind {
    if (t.debit_account != null && t.credit_account != null) return 'transfer';
    if (t.debit_account != null) return 'expense';
    return 'income';
}
