import type { BankLinkDto } from '../services/bank/links';
export interface User {
  id: number;
  email: string;
  password_hash: string;
  name: string;
  currency: string;
  currency_scale: number;
  created_at: Date;
}

export interface Category {
  id: number;
  user_id: number | null;
  name: string;
  parent_id: number | null;
  color: string;
  icon: string;
  created_at: Date;
  /** Display name of the category's owner; null for system categories. */
  owner_name?: string | null;
  /** Ancestor path below the system root, e.g. "Food / Groceries". */
  fullName: string;
  /** The Income (1) / Expenses (2) root this category descends from. */
  root_id: number;
  /** Absent when the category travels alone, e.g. on a transaction. */
  children?: Category[];
}

export type AccountType = 'cash' | 'bank' | 'crypto' | 'investment' | 'property' | 'deposit';

export interface Account {
  id: number;
  user_id: number;
  name: string;
  currency: string;
  start_balance: number;
  scale: number;
  balance: number;
  user_balance?: number | null;
  /** Date (YYYY-MM-DD) of the latest transaction on either side; null when none. Set by services/accounts.ts. */
  last_transaction_date?: string | null;
  created_at: Date;
  deleted?: boolean;
  type: AccountType;
  settings: Record<string, unknown>;
  /** The requesting user's level on this account; set by services/accounts.ts. */
  access_level?: 1 | 2 | 3 | 4;
  /** Display name of the account's owner; set by the accounts query. */
  owner_name?: string;
  /** Transactions come from the blockchain; set by services/accounts.ts. */
  tracked?: boolean;
  /** The bank account feeding this one; set by services/accounts.ts, null when none. */
  bank_link?: BankLinkDto | null;
}

export interface Transaction {
  id: number;
  user_id: number;
  category_id: number | null;
  debit_account_id: number | null;
  credit_account_id: number | null;
  debit: number;
  credit: number;
  date: string;
  description: string;
  payee: string | null;
  created_at: Date;
}

export interface TransactionAccount {
  id: number;
  name: string;
  currency: string;
  scale: number;
  balance?: number;
}

export interface TransactionDTO {
  id: number;
  user_id: number;
  category: Category | null;
  debit_account: TransactionAccount | null;
  credit_account: TransactionAccount | null;
  debit: number;
  credit: number;
  date: string;
  description: string;
  payee: string | null;
  /** The on-chain transaction this row was synced from, else null. */
  txid: string | null;
  created_at: Date;
}

export interface AccountMember {
  user_id: number;
  name: string;
  email: string;
  level: 1 | 2 | 3 | 4;
  is_creator: boolean;
}

export interface ApiResponse<T> {
  data: T | null;
  error: string | null;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  user?: { id: number; email: string; name: string; currency: string; currency_scale: number };
}

export interface JwtPayload {
  userId: number;
  type: 'access' | 'refresh';
}
