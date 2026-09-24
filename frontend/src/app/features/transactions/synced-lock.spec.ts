import { describe, it, expect } from 'vitest';
import { syncedLock } from './synced-lock';

const acc = (id: number) => ({ id, name: `#${id}`, currency: 'BTC', scale: 8 });
const tracked = new Set([1, 2]);

describe('syncedLock', () => {
  it('locks nothing on an ordinary transaction', () => {
    expect(syncedLock({ debit_account: acc(3), credit_account: null }, tracked))
      .toEqual({ synced: false, debitLocked: false, creditLocked: false });
  });

  it('locks the synced side only', () => {
    expect(syncedLock({ debit_account: acc(1), credit_account: acc(3) }, tracked))
      .toEqual({ synced: true, debitLocked: true, creditLocked: false });
  });

  it('locks both sides of a transfer between synced wallets', () => {
    expect(syncedLock({ debit_account: acc(1), credit_account: acc(2) }, tracked))
      .toEqual({ synced: true, debitLocked: true, creditLocked: true });
  });
});
