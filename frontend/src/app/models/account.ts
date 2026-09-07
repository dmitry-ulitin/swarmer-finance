export interface Account {
  id: number;
  user_id: number;
  name: string;
  currency: string;
  scale: number;
  start_balance: number;
  balance: number;
  user_balance: number | null;
  created_at: string;
}
