import * as accountQueries from '../db/queries/accounts';
import * as userQueries from '../db/queries/users';
import { getAccountBalances, getAccountDailyFlows, findTransferPeersForUpdate, purgeAccountTransactions, clearSeenTxids, findSeenTxids } from '../db/queries/transactions';
import { listValuations } from '../db/queries/valuations';
import { accountValueAt } from './accountValue';
import { withTransaction } from '../db';
import { getRatesTo, convertAmount, toDecimal, toCents } from './currency';
import { Account, AccountType, User } from '../types';
import { LEVEL, AccessLevel, getAccessMap, getAccountLevel, getAccessibleAccountIds, requireLevel, requireLevelOnAll } from './access';
import { ChainProvider, getProvider, isTracked } from './chain';
import { getCurrencyScale } from './currencyScale';
import { listLinks } from '../db/queries/bank';
import { getNetWorthFlags, upsertNetWorthFlag } from '../db/queries/accountUserSettings';
import { BankLinkInput, applyLink, checkLink, getLinkDtos } from './bank/links';

function toDecimalDTO(account: Account, userScale: number): Account {
  return {
    ...account,
    start_balance: toDecimal(account.start_balance, account.scale),
    balance: toDecimal(account.balance, account.scale),
    invested: account.invested != null ? toDecimal(account.invested, account.scale) : account.invested,
    user_balance: account.user_balance != null ? toDecimal(account.user_balance, userScale) : account.user_balance,
    tracked: isTracked(account),
  };
}

async function withBalances(accounts: Account[]): Promise<Account[]> {
  const ids = accounts.map(a => a.id);
  const [rows, valuations] = await Promise.all([getAccountBalances(ids), listValuations(ids)]);
  const valuedIds = [...new Set(valuations.map(v => v.account_id))];
  const flows = await getAccountDailyFlows(valuedIds);
  return accounts.map(account => {
    let invested = Number(account.start_balance);
    let lastDate: string | null = null;
    for (const row of rows) {
      if (row.credit_account_id === account.id) invested += row.credit;
      if (row.debit_account_id === account.id) invested -= row.debit;
      if ((row.credit_account_id === account.id || row.debit_account_id === account.id)
        && (lastDate === null || row.last_date > lastDate)) lastDate = row.last_date;
    }
    const own = valuations.filter(v => v.account_id === account.id);
    const balance = own.length === 0 ? invested : accountValueAt({
      startBalance: Number(account.start_balance),
      startDate: null,
      flows: flows.filter(f => f.account_id === account.id),
      valuations: own.map(v => ({ as_of: v.as_of, value: Number(v.value) })),
    }, null).value;
    return {
      ...account, balance, invested, last_transaction_date: lastDate,
      last_valuation_date: own.length ? own[own.length - 1].as_of : null,
    };
  });
}

/** Without an explicit choice an account counts toward net worth for its (co-)owners only. */
export function isInNetWorth(flag: boolean | undefined, level: AccessLevel): boolean {
  return flag ?? level >= LEVEL.ADMIN;
}

/** Stores the user's choice only when it differs from what they have now, so defaults stay defaults. */
async function applyNetWorthFlag(accountId: number, userId: number, include: boolean | undefined): Promise<void> {
  if (include === undefined) return;
  const level = await getAccountLevel(accountId, userId) ?? LEVEL.READ;
  const flag = (await getNetWorthFlags(userId, [accountId])).get(accountId);
  if (isInNetWorth(flag, level) !== include) await upsertNetWorthFlag(userId, accountId, include);
}

async function withBankLink(account: Account, userId: number): Promise<Account> {
  const level = account.access_level ?? await getAccountLevel(account.id, userId) ?? LEVEL.READ;
  const flag = (await getNetWorthFlags(userId, [account.id])).get(account.id);
  return {
    ...account,
    bank_link: (await getLinkDtos([account.id], userId)).get(account.id) ?? null,
    in_net_worth: isInNetWorth(flag, level),
  };
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
 * and is kept in one of the currencies the chain carries.
 */
function assertTrackedShape(provider: ChainProvider, currency: string, startBalance: number | undefined): void {
  if (startBalance != null && startBalance !== 0) {
    throw { statusCode: 400, message: 'A blockchain-synced account starts at 0; its balance comes from the chain' };
  }
  if (!(currency in provider.currencies)) {
    const allowed = Object.keys(provider.currencies).join(' or ');
    throw { statusCode: 400, message: `A blockchain-synced account must be in ${allowed}` };
  }
}

/** Settings with the address in the provider's canonical form, so one wallet has one spelling. */
function normalizeSettings(provider: ChainProvider | null, settings: Record<string, unknown>): Record<string, unknown> {
  return provider?.normalizeAddress
    ? { ...settings, address: provider.normalizeAddress(settings.address as string) }
    : settings;
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
  const bankLinks = await getLinkDtos(converted.map(a => a.id), userId);
  const flags = await getNetWorthFlags(userId, converted.map(a => a.id));
  return converted.map(a => ({
    ...toDecimalDTO(a, user.currency_scale),
    bank_link: bankLinks.get(a.id) ?? null,
    in_net_worth: isInNetWorth(flags.get(a.id), a.access_level!),
  }));
};

export const createAccount = async (
  userId: number,
  name: string,
  currency: string,
  startBalance: number,
  type: AccountType = 'cash',
  settings: Record<string, unknown> = {},
  bankLink: BankLinkInput | null = null,
  inNetWorth?: boolean
) => {
  const user = await getUserOrThrow(userId);
  if (bankLink) await checkLink(userId, { type, currency }, bankLink);
  const provider = isTracked({ type, settings }) ? getProvider(settings.blockchain) : null;
  if (provider) {
    assertTrackedShape(provider, currency, startBalance);
  }
  settings = normalizeSettings(provider, settings);
  const scale = getCurrencyScale(currency);
  const account = await accountQueries.createAccount(userId, name, currency, toCents(startBalance, scale), scale, type, settings);
  if (bankLink) await applyLink(account.id, bankLink);
  await applyNetWorthFlag(account.id, userId, inNetWorth);
  const [converted] = await withConvertedBalances(user, [{ ...account, balance: Number(account.start_balance), invested: Number(account.start_balance), last_transaction_date: null, last_valuation_date: null }]);
  return withBankLink(toDecimalDTO(converted, user.currency_scale), userId);
};

/** Any member may choose whether the account counts toward their own net worth. */
export const setInNetWorth = async (id: number, userId: number, include: boolean) => {
  const existing = await accountQueries.getAccountById(id);
  if (!existing) {
    throw { statusCode: 404, message: 'Account not found' };
  }
  await requireLevel(id, userId, LEVEL.READ);
  if (existing.deleted) {
    throw { statusCode: 404, message: 'Account is deleted' };
  }
  await upsertNetWorthFlag(userId, id, include);
  const user = await getUserOrThrow(userId);
  const level = await getAccountLevel(id, userId) ?? LEVEL.READ;
  const [withBal] = await withBalances([{ ...existing, access_level: level }]);
  const [converted] = await withConvertedBalances(user, [withBal]);
  return withBankLink(toDecimalDTO(converted, user.currency_scale), userId);
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
    /** Omitted keeps the current link, null removes it. */
    bankLink?: BankLinkInput | null;
    /** The caller's own net-worth choice; omitted keeps it. */
    inNetWorth?: boolean;
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
  const [currentLink] = await listLinks([id]);
  // Resending the current link is no change, so a co-owner can edit an
  // account linked through someone else's connection.
  const linkChanges = data.bankLink !== undefined && !(
    data.bankLink && currentLink
    && data.bankLink.connectionId === currentLink.connection_id && data.bankLink.uid === currentLink.uid
  ) && !(data.bankLink === null && !currentLink);
  const nextCurrency = data.currency ?? existing.currency;
  if (linkChanges && data.bankLink) {
    await checkLink(userId, { type: data.type, currency: nextCurrency }, data.bankLink);
  } else if (currentLink && !linkChanges && (
    data.type !== existing.type
    // A multi-currency bank account fits any currency; the connection's
    // owner need not be the one changing it.
    || (nextCurrency !== existing.currency && currentLink.acc_currency !== 'XXX')
  )) {
    // The link was checked against the old type and currency.
    throw { statusCode: 400, message: 'Unlink the bank first' };
  }

  let hasTx: boolean | undefined;
  const hasTransactions = async () => hasTx ??= await accountQueries.hasTransactions(id);

  const currency = data.currency ?? existing.currency;
  let scale = existing.scale;
  if (getCurrencyScale(currency) !== existing.scale) {
    // Stored amounts are integers at the account's scale; rescaling an
    // account that already holds some would silently change every one.
    if (!await hasTransactions()) {
      scale = getCurrencyScale(currency);
    } else if (currency !== existing.currency) {
      throw {
        statusCode: 400,
        message: `Cannot change the currency to ${currency}: it has a different scale and the account already has transactions`,
      };
    }
  }

  const provider = isTracked(data) ? getProvider(data.settings.blockchain) : null;
  data = { ...data, settings: normalizeSettings(provider, data.settings) };
  const wasTracked = isTracked(existing);
  // A wallet is an address on a chain in one currency: TRON's TRX and USDT
  // at the same address are separate histories.
  const sameWallet = wasTracked
    && existing.settings.address === data.settings.address
    && existing.settings.blockchain === data.settings.blockchain
    && existing.currency === currency;
  if (provider) {
    assertTrackedShape(provider, currency, data.startBalance);
    // Rows already on a tracked account came from its wallet; pointing it at
    // another wallet would mix two histories — unless it never synced, so
    // none of its rows are provably that wallet's; the next sync then
    // reconciles them like any other switch-on.
    if (wasTracked && !sameWallet && (await findSeenTxids(id)).length > 0) {
      const onlyCurrency = existing.settings.address === data.settings.address
        && existing.settings.blockchain === data.settings.blockchain;
      throw {
        statusCode: 400,
        message: onlyCurrency
          ? 'Cannot change the currency of an account that has already synced; create a new account'
          : 'Cannot change the wallet of an account that already has transactions',
      };
    }
  }
  // Switching tracking on, or pointing an already-tracked account at a
  // different (never-synced) wallet: the balance comes from the chain from
  // now on, and an empty seen set makes the next sync read the whole history
  // and reconcile the rows already here.
  const enablesTracking = provider !== null && !wasTracked;
  const walletChanges = provider !== null && !sameWallet;

  const startBalance = enablesTracking
    ? 0
    : data.startBalance != null ? toCents(data.startBalance, scale) : undefined;
  // Changing the opening balance would silently shift every balance after
  // it; once there are transactions a correcting transaction does that
  // visibly. Switching tracking on zeroes it on purpose (the chain owns it).
  if (!enablesTracking && startBalance !== undefined
    && startBalance !== Number(existing.start_balance)
    && await hasTransactions()) {
    throw {
      statusCode: 400,
      message: 'Cannot change the start balance: the account already has transactions; add a correcting transaction instead',
    };
  }
  const account = await withTransaction(async tx => {
    if (enablesTracking) {
      // Reconciliation on the first sync can re-point rows of other
      // accounts (services/chainAdopt.ts); require WRITE on every transfer
      // peer up front, the same guard purgeAccount uses, so a sync that
      // would later 403 mid-way never gets the chance to commit tracking.
      const peers = await findTransferPeersForUpdate(tx, id);
      await requireLevelOnAll(peers, userId, LEVEL.WRITE);
    }
    if (walletChanges) await clearSeenTxids(tx, id);
    return accountQueries.updateAccount(id, { ...data, scale, startBalance }, tx);
  });
  // Soft-deleted by a concurrent request since the check above.
  if (!account) {
    throw { statusCode: 404, message: 'Account is deleted' };
  }
  if (linkChanges) await applyLink(id, data.bankLink!);
  await applyNetWorthFlag(id, userId, data.inNetWorth);
  const [withBal] = await withBalances([account]);
  const [converted] = await withConvertedBalances(user, [withBal]);
  return withBankLink(toDecimalDTO(converted, user.currency_scale), userId);
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
  const balance = accountWithBalance.invested;

  if (balance !== 0) {
    throw {
      statusCode: 409,
      message: `Account has a non-zero transaction balance (${balance}) and transactions; cannot delete`,
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
