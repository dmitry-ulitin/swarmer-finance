import type { Transaction } from '../../models/transaction';

/**
 * Which sides of a transaction the blockchain owns. A locked side's account
 * and amount — and, on any synced transaction, the date and payee — are
 * fixed. Mirrors assertSyncedEdit in backend/src/services/transactions.ts;
 * the backend is the authority, this only shapes the form.
 */
export interface SyncedLock {
  synced: boolean;
  debitLocked: boolean;
  creditLocked: boolean;
}

export function syncedLock(
  t: Partial<Pick<Transaction, 'debit_account' | 'credit_account'>>,
  trackedIds: ReadonlySet<number>
): SyncedLock {
  const debitLocked = t.debit_account != null && trackedIds.has(t.debit_account.id);
  const creditLocked = t.credit_account != null && trackedIds.has(t.credit_account.id);
  return { synced: debitLocked || creditLocked, debitLocked, creditLocked };
}
