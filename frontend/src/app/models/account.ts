export type AccountType = 'cash' | 'bank' | 'crypto';

export interface AccountSettings {
  cash: Record<string, never>;
  bank: { accountNumber?: string };
  crypto: { address?: string; blockchain?: string };
}

interface AccountBase {
  id: number;
  user_id: number;
  name: string;
  currency: string;
  scale: number;
  start_balance: number;
  balance: number;
  user_balance: number | null;
  deleted: boolean;
  created_at: string;
}

// A union over type, so `@if (account.type === 'crypto')` narrows
// `account.settings` to the crypto shape in templates and code.
export type Account = {
  [T in AccountType]: AccountBase & { type: T; settings: AccountSettings[T] };
}[AccountType];

// What the account form submits. `type` and `settings` always travel
// together, and the backend requires `type` on PUT as well as POST.
export type AccountPayload = {
  name: string;
  currency: string;
  startBalance: number;
} & {
  [T in AccountType]: { type: T; settings: AccountSettings[T] };
}[AccountType];
