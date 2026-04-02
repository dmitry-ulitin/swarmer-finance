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

export interface Transaction {
  id: number;
  user_id: number;
  category_id: number;
  amount: number;
  currency: string;
  date: Date;
  description: string;
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
