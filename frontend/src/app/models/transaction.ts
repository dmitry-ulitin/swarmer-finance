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

export enum TransactionType {
    Transfer = 0,
    Income,
    Expense
}

export interface TransactionView extends Transaction {
    accountName: string;
    formattedAmount: string;
    type: TransactionType;
}

export function getTransactionType(t: Transaction): TransactionType {
    if (t.debit_account != null && t.credit_account != null) return TransactionType.Transfer;
    if (t.debit_account != null) return TransactionType.Expense;
    return TransactionType.Income;
}
