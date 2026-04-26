export interface User {
  id: number;
  email: string;
  password_hash: string;
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
  children?: Category[];
}

export interface Account {
  id: number;
  user_id: number;
  name: string;
  currency: string;
  start_balance: number;
  created_at: Date;
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
  date: Date;
  description: string;
  payee: string | null;
  created_at: Date;
}

export interface ApiResponse<T> {
  data: T | null;
  error: string | null;
}

export interface AuthTokens {
  accessToken: string;
  refreshToken: string;
  user?: { id: number; email: string };
}

export interface JwtPayload {
  userId: number;
  type: 'access' | 'refresh';
}
