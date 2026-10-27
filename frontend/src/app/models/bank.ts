export interface BankCredentials {
  enabled: boolean;
  applicationId: string | null;
  hasKey: boolean;
}

export interface BankAspsp {
  name: string;
  country: string;
  beta: boolean;
  maxConsentDays: number;
}

export type BankStatus = 'pending' | 'active' | 'expiring' | 'expired';

export interface BankConnection {
  id: number;
  aspspName: string;
  country: string;
  status: BankStatus;
  validUntil: string | null;
  accounts: { uid: string; iban: string | null; name: string | null; currency: string }[];
}

export interface BankLink {
  connectionId: number;
  uid: string;
  aspspName: string;
  accountName: string | null;
  iban: string | null;
  /** The bank account's currency; `XXX` means several currencies. */
  currency: string;
  status: BankStatus | 'unmapped';
  validUntil: string | null;
  loadedTo: string | null;
  ownConnection: boolean;
}

/** Countries Enable Banking covers: the ones in use first, then the other EEA codes. */
export const BANK_COUNTRIES: readonly string[] = [
  'EE', 'CY', 'ES', 'RO',
  'AT', 'BE', 'BG', 'HR', 'CZ', 'DK', 'FI', 'FR', 'DE', 'GR', 'HU', 'IS', 'IE', 'IT',
  'LV', 'LI', 'LT', 'LU', 'MT', 'NL', 'NO', 'PL', 'PT', 'SK', 'SI', 'SE',
];

/** Where the bank sends the user back after consent; registered in Enable Banking. */
export const bankRedirectUrl = (): string => `${location.origin}/bank-callback`;
