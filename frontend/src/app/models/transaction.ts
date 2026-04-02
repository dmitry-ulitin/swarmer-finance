export enum TransactionType {
    Transfer = 0,
    Income,
    Expense,
    Correction
}

export interface Transaction {
    id: number;
    user_id: number;
    category_id: number;
    amount: number;
    currency: string;
    date: string;
    description: string;
    created_at: string;
}
