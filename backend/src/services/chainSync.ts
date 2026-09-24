import { Tx, withTransaction } from '../db';
import * as accountQueries from '../db/queries/accounts';
import * as transactionQueries from '../db/queries/transactions';
import { Account } from '../types';
import { AccessLevel, LEVEL, getAccessMap } from './access';
import { ChainTx, getProvider, isTracked } from './chain';
import { suggestCategories } from './import/categorize';
import { getTreeCategoryIds, resolveCategoryForOwner } from './categories';

const UNCATEGORIZED_INCOME_CATEGORY_ID = 3;
const UNCATEGORIZED_EXPENSE_CATEGORY_ID = 4;
const NETWORK_FEES_CATEGORY_ID = 5;

export interface SyncResult {
  /** New income / expense / transfer rows. */
  added: number;
  /** Rows of another synced wallet turned into a transfer with this one. */
  merged: number;
  /** New Network fees rows. */
  fees: number;
}

/**
 * The ledger rows one on-chain transaction becomes for the synced account.
 * Receiving and paying are exclusive (see toChainTx), so a plan has either
 * `income`, or any of `transfer` / `expense` / a fee.
 */
export interface Plan {
  txid: string;
  date: string;
  fee: number;
  income?: { amount: number; from: string; peer: Account | undefined };
  /** Sent to another synced wallet of this user. */
  transfer?: { amount: number; peer: Account };
  /** Sent to anyone else, summed. */
  expense?: { amount: number; to: string };
}

const sum = (xs: { amount: number }[]) => xs.reduce((s, x) => s + x.amount, 0);

/**
 * Only the first synced peer paid in a transaction becomes a transfer; a
 * second synced peer in the same transaction is filed with the expense
 * (out of scope in the spec — practically never happens).
 */
export function planTx(tx: ChainTx, peers: ReadonlyMap<string, Account>): Plan {
  const plan: Plan = { txid: tx.txid, date: tx.date, fee: tx.fee };
  const incoming = tx.transfers.filter(t => t.amount > 0);
  if (incoming.length > 0) {
    const from = incoming[0].counterparty;
    plan.income = { amount: sum(incoming), from, peer: peers.get(from) };
    return plan;
  }

  const outgoing = tx.transfers.filter(t => t.amount < 0);
  const peerAddress = outgoing.find(t => peers.has(t.counterparty))?.counterparty;
  const toPeer = outgoing.filter(t => t.counterparty === peerAddress);
  const rest = outgoing.filter(t => t.counterparty !== peerAddress);
  if (peerAddress !== undefined) {
    plan.transfer = { amount: -sum(toPeer), peer: peers.get(peerAddress)! };
  }
  if (rest.length > 0) {
    plan.expense = { amount: -sum(rest), to: rest[0].counterparty };
  }
  return plan;
}

/** Other synced wallets on the same chain the user can write, by address. */
async function loadPeers(access: Map<number, AccessLevel>, account: Account): Promise<Map<string, Account>> {
  const writable = [...access]
    .filter(([id, level]) => id !== account.id && level >= LEVEL.WRITE)
    .map(([id]) => id);
  const accounts = await accountQueries.getAccountsByIds(writable);
  return new Map(
    accounts
      .filter(a => !a.deleted && isTracked(a) && a.settings.blockchain === account.settings.blockchain)
      .map(a => [a.settings.address as string, a])
  );
}

/**
 * Suggested category per txid for the income or expense row a plan files,
 * learned from history exactly like statement import, and resolved against
 * the account owner — the rows are stored in the owner's tree even when a
 * co-user runs the sync.
 */
async function suggest(userId: number, account: Account, access: Map<number, AccessLevel>, plans: Plan[]): Promise<Map<string, number>> {
  const filed = plans.filter(p => p.income || p.expense);
  if (filed.length === 0) return new Map();

  const history = await transactionQueries.findCategorizedHistory([...access.keys()]);
  const treeIds = await getTreeCategoryIds(userId);
  const suggestions = suggestCategories(
    filed.map(p => ({
      amount: p.income ? 1 : -1,
      payee: p.income ? p.income.from : p.expense!.to,
      description: '',
    })),
    history.flatMap(h => {
      const categoryId = treeIds.get(h.categoryId);
      return categoryId === undefined ? [] : [{ ...h, categoryId }];
    })
  );

  const result = new Map<string, number>();
  for (let i = 0; i < filed.length; i++) {
    const categoryId = suggestions[i].categoryId;
    if (categoryId !== null) {
      result.set(filed[i].txid, await resolveCategoryForOwner(categoryId, account.user_id));
    }
  }
  return result;
}

async function apply(
  db: Tx,
  userId: number,
  account: Account,
  plan: Plan,
  categories: Map<string, number>,
  result: SyncResult
): Promise<void> {
  const row = (fields: {
    debitAccountId?: number; creditAccountId?: number; amount: number;
    categoryId: number | null; payee: string | null; importHash: string;
  }) => transactionQueries.insertSynced(db, userId, {
    debitAccountId: fields.debitAccountId,
    creditAccountId: fields.creditAccountId,
    debit: fields.amount,
    credit: fields.amount,
    categoryId: fields.categoryId ?? undefined,
    date: plan.date,
    description: '',
    payee: fields.payee,
    importHash: fields.importHash,
  });

  if (plan.income) {
    const { amount, from, peer } = plan.income;
    // The sender is a synced wallet that already filed this tx as its own
    // expense (or a hand-set transfer): that row becomes the transfer, and
    // whatever else it paid stays behind as an expense — the same rows a
    // fresh sync of the sender would produce now.
    const sent = peer && await transactionQueries.findByImportHashForUpdate(db, peer.id, 'debit', plan.txid);
    if (sent && Number(sent.debit) >= amount) {
      await transactionQueries.setSyncedShape(db, sent.id, {
        debitAccountId: peer!.id, creditAccountId: account.id, debit: amount, credit: amount, categoryId: null,
      });
      const remainder = Number(sent.debit) - amount;
      if (remainder > 0) {
        await transactionQueries.insertSynced(db, sent.user_id, {
          debitAccountId: peer!.id,
          debit: remainder,
          credit: remainder,
          categoryId: sent.category_id ?? UNCATEGORIZED_EXPENSE_CATEGORY_ID,
          date: plan.date,
          description: '',
          payee: sent.payee,
          importHash: `${plan.txid}:out`,
        });
      }
      result.merged++;
    } else if (await row({
      creditAccountId: account.id, amount,
      categoryId: categories.get(plan.txid) ?? UNCATEGORIZED_INCOME_CATEGORY_ID,
      payee: from, importHash: plan.txid,
    })) {
      result.added++;
    }
  }

  if (plan.transfer) {
    const { amount, peer } = plan.transfer;
    // The receiver synced first and filed this tx as income (or the user
    // pointed it at another source): rule 3 — it is one transfer, ours.
    const received = await transactionQueries.findByImportHashForUpdate(db, peer.id, 'credit', plan.txid);
    if (received) {
      await transactionQueries.setSyncedShape(db, received.id, {
        debitAccountId: account.id, creditAccountId: peer.id, debit: amount, credit: amount, categoryId: null,
      });
      result.merged++;
    } else if (await row({
      debitAccountId: account.id, creditAccountId: peer.id, amount,
      categoryId: null, payee: peer.settings.address as string, importHash: plan.txid,
    })) {
      result.added++;
    }
  }

  if (plan.expense && await row({
    debitAccountId: account.id, amount: plan.expense.amount,
    categoryId: categories.get(plan.txid) ?? UNCATEGORIZED_EXPENSE_CATEGORY_ID,
    payee: plan.expense.to,
    // A transfer already holds the plain txid on this account.
    importHash: plan.transfer ? `${plan.txid}:out` : plan.txid,
  })) {
    result.added++;
  }

  if (plan.fee > 0 && await row({
    debitAccountId: account.id, amount: plan.fee,
    categoryId: NETWORK_FEES_CATEGORY_ID, payee: null, importHash: `${plan.txid}:fee`,
  })) {
    result.fees++;
  }
}

export const syncAccount = async (userId: number, accountId: number): Promise<SyncResult> => {
  const account = await accountQueries.getAccountById(accountId);
  // Same as import: a missing or deleted account is 403, not 404, so ids of
  // other users' accounts cannot be probed.
  if (!account || account.deleted) {
    throw { statusCode: 403, message: 'Cannot use this account' };
  }
  const access = await getAccessMap(userId);
  if ((access.get(accountId) ?? 0) < LEVEL.WRITE) {
    throw { statusCode: 403, message: 'Insufficient permissions for this account' };
  }
  if (!isTracked(account)) {
    throw { statusCode: 400, message: 'This account is not synced from a blockchain' };
  }

  // Everything from the network first: a failure part-way through paging
  // must leave the database untouched.
  const provider = getProvider(account.settings.blockchain)!;
  const known = new Set(await transactionQueries.findSyncedTxids(accountId));
  const txs = await provider.fetchNewTxs(account.settings.address as string, known);
  if (txs.length === 0) return { added: 0, merged: 0, fees: 0 };

  const peers = await loadPeers(access, account);
  const plans = txs.map(tx => planTx(tx, peers));
  const categories = await suggest(userId, account, access, plans);

  return withTransaction(async db => {
    const result: SyncResult = { added: 0, merged: 0, fees: 0 };
    for (const plan of plans) {
      await apply(db, userId, account, plan, categories, result);
    }
    return result;
  });
};
