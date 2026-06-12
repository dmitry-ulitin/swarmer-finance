export interface Account {
  id: number;
  user_id: number;
  name: string;
  currency: string;
  scale: number;
  start_balance: number;
  balance: number;
  created_at: string;
}
