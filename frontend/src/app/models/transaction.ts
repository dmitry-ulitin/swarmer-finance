export enum TransactionType {
    Transfer = 0,
    Income,
    Expense,
    Correction
}

export interface Transaction {
    id: number;
    user_id: number;
    category_id: number | null;
    debit_account_id: number | null;
    credit_account_id: number | null;
    debit: number;
    credit: number;
    currency: string | null;
    date: string;
    description: string;
    payee: string | null;
    created_at: string;
}

export type TransactionKind = 'expense' | 'income' | 'transfer';

export function getTransactionKind(t: Transaction): TransactionKind {
    if (t.debit_account_id != null && t.credit_account_id != null) return 'transfer';
    if (t.debit_account_id != null) return 'expense';
    return 'income';
}
