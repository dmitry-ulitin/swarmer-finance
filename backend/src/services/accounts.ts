import * as accountQueries from '../db/queries/accounts';
import * as userQueries from '../db/queries/users';
import { getAccountBalances, findTransferPeersForUpdate, purgeAccountTransactions, clearSeenTxids } from '../db/queries/transactions';
import { withTransaction } from '../db';
import { getRatesTo, convertAmount, toDecimal, toCents } from './currency';
import { Account, AccountType, User } from '../types';
import { LEVEL, AccessLevel, getAccessMap, getAccessibleAccountIds, requireLevel, requireLevelOnAll } from './access';
import { ChainProvider, getProvider, isTracked } from './chain';
import { getCurrencyScale } from './currencyScale';

function toDecimalDTO(account: Account, userScale: number): Account {
  return {
    ...account,
    start_balance: toDecimal(account.start_balance, account.scale),
    balance: toDecimal(account.balance, account.scale),
    user_balance: account.user_balance != null ? toDecimal(account.user_balance, userScale) : account.user_balance,
    tracked: isTracked(account),
  };
}

async function withBalances(accounts: Account[]): Promise<Account[]> {
  const rows = await getAccountBalances(accounts.map(a => a.id));
  return accounts.map(account => {
    let balance = Number(account.start_balance);
    for (const row of rows) {
      if (row.credit_account_id === account.id) balance += row.credit;
      if (row.debit_account_id === account.id) balance -= row.debit;
    }
    return { ...account, balance };
  });
}

async function getUserOrThrow(userId: number): Promise<User> {
  const user = await userQueries.getUserById(userId);
  if (!user) {
    throw { statusCode: 401, message: 'User not found' };
  }
  return user;
}

/**
 * A synced account's balance comes only from the chain, so it starts at 0
 * and is kept in the chain's own currency.
 */
function assertTrackedShape(provider: ChainProvider, currency: string, startBalance: number | undefined): void {
  if (startBalance != null && startBalance !== 0) {
    throw { statusCode: 400, message: 'A blockchain-synced account starts at 0; its balance comes from the chain' };
  }
  if (currency !== provider.currency) {
    throw { statusCode: 400, message: `A blockchain-synced account must be in ${provider.currency}` };
  }
}

async function withConvertedBalances(user: User, accounts: Account[]): Promise<Account[]> {
  const rates = await getRatesTo(user.currency, accounts.map(a => a.currency));
  return accounts.map(account => {
    const rate = rates.get(account.currency) ?? null;
    const userBalance = convertAmount(account.balance, account.scale, rate, user.currency_scale);
    return { ...account, user_balance: userBalance };
  });
}

export const getAccounts = async (userId: number) => {
  const user = await getUserOrThrow(userId);
  const accessMap = await getAccessMap(userId);
  const accounts = await accountQueries.getAccountsByIds([...accessMap.keys()]);
  const withLevel = accounts.map(a => ({ ...a, access_level: accessMap.get(a.id)! }));
  const withBal = await withBalances(withLevel);
  const converted = await withConvertedBalances(user, withBal);
  return converted.map(a => toDecimalDTO(a, user.currency_scale));
};

export const createAccount = async (
  userId: number,
  name: string,
  currency: string,
  startBalance: number,
  type: AccountType = 'cash',
  settings: Record<string, unknown> = {}
) => {
  const user = await getUserOrThrow(userId);
  const provider = isTracked({ type, settings }) ? getProvider(settings.blockchain) : null;
  if (provider) {
    assertTrackedShape(provider, currency, startBalance);
  }
  const scale = getCurrencyScale(currency);
  const account = await accountQueries.createAccount(userId, name, currency, toCents(startBalance, scale), scale, type, settings);
  const [converted] = await withConvertedBalances(user, [{ ...account, balance: Number(account.start_balance) }]);
  return toDecimalDTO(converted, user.currency_scale);
};

export const updateAccount = async (
  id: number,
  userId: number,
  data: {
    name?: string;
    currency?: string;
    startBalance?: number;
    type: AccountType;
    settings: Record<string, unknown>;
  }
) => {
  const existing = await accountQueries.getAccountById(id);
  if (!existing) {
    throw { statusCode: 404, message: 'Account not found' };
  }
  await requireLevel(id, userId, LEVEL.ADMIN);
  if (existing.deleted) {
    throw { statusCode: 404, message: 'Account is deleted' };
  }
  const user = await getUserOrThrow(userId);

  const currency = data.currency ?? existing.currency;
  let scale = existing.scale;
  if (getCurrencyScale(currency) !== existing.scale) {
    // Stored amounts are integers at the account's scale; rescaling an
    // account that already holds some would silently change every one.
    if (!await accountQueries.hasTransactions(id)) {
      scale = getCurrencyScale(currency);
    } else if (currency !== existing.currency) {
      throw {
        statusCode: 400,
        message: `Cannot change the currency to ${currency}: it has a different scale and the account already has transactions`,
      };
    }
  }

  const provider = isTracked(data) ? getProvider(data.settings.blockchain) : null;
  const wasTracked = isTracked(existing);
  if (provider) {
    assertTrackedShape(provider, currency, data.startBalance);
    // Rows already on a tracked account came from its wallet; pointing it at
    // another wallet would mix two histories. An untracked account's rows are
    // reconciled by its first sync instead (services/chainAdopt.ts).
    const sameWallet = wasTracked
      && existing.settings.address === data.settings.address
      && existing.settings.blockchain === data.settings.blockchain;
    if (wasTracked && !sameWallet && (Number(existing.start_balance) !== 0 || await accountQueries.hasTransactions(id))) {
      throw { statusCode: 400, message: 'Cannot change the wallet of an account that already has transactions' };
    }
  }
  // Switching tracking on: the balance comes from the chain from now on, and
  // an empty seen set makes the next sync read the whole history and
  // reconcile the rows already here.
  const enablesTracking = provider !== null && !wasTracked;

  const startBalance = enablesTracking
    ? 0
    : data.startBalance != null ? toCents(data.startBalance, scale) : undefined;
  const account = await withTransaction(async tx => {
    if (enablesTracking) await clearSeenTxids(tx, id);
    return accountQueries.updateAccount(id, { ...data, scale, startBalance }, tx);
  });
  const [withBal] = await withBalances([account!]);
  const [converted] = await withConvertedBalances(user, [withBal]);
  return toDecimalDTO(converted, user.currency_scale);
};

/**
 * Delete an account using a 3-state policy:
 *
 *   1. No transactions referencing the account → hard DELETE
 *   2. Transactions exist and balance is zero → soft DELETE (deleted = true)
 *   3. Transactions exist and balance is non-zero → 409 Conflict
 *
 * Soft-deleted accounts are hidden from the accounts list UI, but
 * remain visible elsewhere (e.g. when editing existing transactions
 * that reference them) and their transaction history stays intact for
 * audit purposes. Operations that would change a soft-deleted
 * account's balance (creating/updating a transaction against it) must
 * be rejected. The FK from
 * transactions.{debit,credit}_account_id to accounts.id is RESTRICT
 * (migration 004) — that is why we cannot simply hard-delete accounts
 * with transactions attached.
 *
 * Returns one of: { kind: 'hard-deleted' }, { kind: 'soft-deleted' },
 * or throws an HttpError with statusCode: 409 / 404.
 *
 * Deleting requires ADMIN: co-owners of a shared account have equal rights,
 * and deletion is a rare, non-critical clean-up of old empty accounts.
 */
export const deleteAccount = async (
  id: number,
  userId: number
): Promise<{ kind: 'hard-deleted' | 'soft-deleted' }> => {
  // Include-deleted lookup so an already-deleted account reports 404
  // rather than being silently re-soft-deleted.
  const existing = await accountQueries.getAccountById(id);
  if (!existing) {
    throw { statusCode: 404, message: 'Account not found' };
  }
  await requireLevel(id, userId, LEVEL.ADMIN);
  if (existing.deleted) {
    throw { statusCode: 404, message: 'Account is deleted' };
  }

  const hasTx = await accountQueries.hasTransactions(id);

  if (!hasTx) {
    // Foreign keys (transactions.debit_account_id / credit_account_id
    // use ON DELETE RESTRICT, migration 004) guarantee that an account
    // with zero transactions can be hard-deleted without affecting any
    // history.
    const ok = await accountQueries.hardDeleteAccount(id);
    if (!ok) {
      throw { statusCode: 404, message: 'Account not found' };
    }
    return { kind: 'hard-deleted' };
  }

  // Transactions exist — check balance.
  const [accountWithBalance] = await withBalances([existing]);
  const balance = accountWithBalance.balance;

  if (balance !== 0) {
    throw {
      statusCode: 409,
      message: `Account has a non-zero balance (${balance}) and transactions; cannot delete`,
    };
  }

  // Balance is zero — soft delete.
  const ok = await accountQueries.softDeleteAccount(id);
  if (!ok) {
    throw { statusCode: 404, message: 'Account not found' };
  }
  return { kind: 'soft-deleted' };
};

const UNCATEGORIZED_INCOME_CATEGORY_ID = 3;
const UNCATEGORIZED_EXPENSE_CATEGORY_ID = 4;

export interface PurgeResult {
  deleted: number;
  /** Transfers left to their other account as uncategorized income/expense. */
  detached: number;
}

/**
 * Clean-up for accounts made by mistake or for testing: removes every
 * transaction of the account and, with `removeAccount`, the account itself.
 *
 * A transfer is not deleted — the other account's balance must not move —
 * but left to that account as uncategorized income or expense. For a synced
 * wallet that is the row its own sync would have written, so re-syncing the
 * purged wallet (its seen txids are forgotten) merges it back into a transfer.
 *
 * Needs ADMIN on the account, like deleting it, and WRITE on every account
 * across its transfers, like entering one; otherwise nothing changes.
 */
export const purgeAccount = async (
  id: number,
  userId: number,
  removeAccount: boolean
): Promise<PurgeResult> => {
  const existing = await accountQueries.getAccountById(id);
  if (!existing) {
    throw { statusCode: 404, message: 'Account not found' };
  }
  await requireLevel(id, userId, LEVEL.ADMIN);
  if (existing.deleted) {
    throw { statusCode: 404, message: 'Account is deleted' };
  }

  return withTransaction(async (tx) => {
    const peers = await findTransferPeersForUpdate(tx, id);
    await requireLevelOnAll(peers, userId, LEVEL.WRITE);
    const result = await purgeAccountTransactions(
      tx, id, UNCATEGORIZED_INCOME_CATEGORY_ID, UNCATEGORIZED_EXPENSE_CATEGORY_ID
    );
    if (removeAccount) {
      await accountQueries.deleteAccountRow(tx, id);
    }
    return result;
  });
};
