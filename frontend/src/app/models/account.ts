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
  /**
   * The signed-in user's access level on this account:
   * 1 read, 2 transactions, 3 admin, 4 owner. Optional so existing
   * fixtures and forms need not supply it.
   */
  access_level?: 1 | 2 | 3 | 4;
  /** Display name of the account's owner. */
  owner_name?: string;
  /** Transactions come from the blockchain; computed by the backend. */
  tracked?: boolean;
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

export interface AccountSyncResult {
  added: number;
  merged: number;
  fees: number;
  /** Rows already on the account kept as synced rows (first sync only). */
  adopted: number;
  /** Rows already on the account that matched nothing on the chain. */
  removed: number;
}

export interface AccountPurgeResult {
  deleted: number;
  /** Transfers left to their other account as uncategorized income/expense. */
  detached: number;
}

/**
 * Chains the backend syncs from, with the currencies a synced account on
 * them may use. Mirrors the provider registry in
 * backend/src/services/chain/index.ts.
 */
export const SYNCED_CHAINS: Readonly<Record<string, readonly string[]>> = {
  bitcoin: ['BTC'],
  tron: ['TRX', 'USDT'],
};
