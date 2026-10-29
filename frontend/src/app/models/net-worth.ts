import type { AccessLevel, AccountType } from './account';

export interface NetWorthAccount {
  id: number;
  name: string;
  type: AccountType;
  currency: string;
  value: number;
  valueUser: number | null;
  invested: number;
  gain: number;
  gainPct: number | null;
  inNetWorth: boolean;
  /** The user's level on the account, 4 = their own. */
  accessLevel: AccessLevel;
  ownerName: string;
}

export interface NetWorthPoint {
  date: string;
  total: number;
  byType: Record<AccountType, number>;
  approximate: boolean;
}

export interface NetWorth {
  currency: string;
  total: number;
  approximate: boolean;
  byType: { type: AccountType; value: number }[];
  byCurrency: { currency: string; value: number }[];
  accounts: NetWorthAccount[];
  history: NetWorthPoint[];
}
