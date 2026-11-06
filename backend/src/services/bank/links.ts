import { Tx } from '../../db';
import * as bankQueries from '../../db/queries/bank';
import { BankLinkRow, StoredBankBalance } from '../../db/queries/bank';
import { getAccountById } from '../../db/queries/accounts';
import { LEVEL, requireLevel } from '../access';
import { BankConnectionStatus, connectionStatus, getConnection, loadCredentials, markExpired } from './connections';
import { BankAccessError, EbBalance, EbTransaction, PsuContext, fetchBalances, fetchTransactions } from './client';
import { computeBankHashes, toParsedRows } from './rows';
import { ParseResult, buildParseResult, loadWritableAccount } from '../import';
import { addDays, isIsoDate, todayUtc } from '../date';

const FIRST_LOAD_DAYS = 90;
/** A later load re-reads this many days before the marker, for late bookings. */
const OVERLAP_DAYS = 2;

const notLinked = () => ({ statusCode: 400, message: 'This account is not linked to a bank' });
const accessExpired = () => ({ statusCode: 409, message: 'Bank access expired — reconnect' });

export interface BankLinkDto {
  connectionId: number;
  uid: string;
  aspspName: string;
  accountName: string | null;
  iban: string | null;
  currency: string;
  status: BankConnectionStatus | 'unmapped';
  validUntil: string | null;
  loadedTo: string | null;
  ownConnection: boolean;
}

const toDto = (row: BankLinkRow, userId: number): BankLinkDto => ({
  connectionId: row.connection_id,
  uid: row.uid,
  aspspName: row.aspsp_name,
  accountName: row.acc_name,
  iban: row.acc_iban,
  currency: row.acc_currency ?? row.account_currency,
  status: row.acc_uid === null ? 'unmapped' : connectionStatus(row),
  validUntil: row.valid_until ? new Date(row.valid_until).toISOString() : null,
  loadedTo: row.loaded_to,
  ownConnection: row.user_id === userId,
});

export async function getLinkDtos(accountIds: number[], userId: number): Promise<Map<number, BankLinkDto>> {
  const rows = accountIds.length ? await bankQueries.listLinks(accountIds) : [];
  return new Map(rows.map((r) => [r.account_id, toDto(r, userId)]));
}

export interface BankLinkInput {
  connectionId: number;
  uid: string;
}

/**
 * Throws unless the account may be linked to this bank account: it is a
 * `bank` account, the connection is the caller's own and has the account,
 * and the currencies match (a multi-currency `XXX` bank account fits any).
 * The caller has already checked ADMIN on the app account.
 */
export async function checkLink(
  userId: number,
  account: { type: string; currency: string },
  link: BankLinkInput
): Promise<void> {
  if (account.type !== 'bank') {
    throw { statusCode: 400, message: 'Only a bank account can be linked to a bank' };
  }
  await getConnection(userId, link.connectionId);
  const bankAccount = (await bankQueries.listConnectionAccounts([link.connectionId])).find((a) => a.uid === link.uid);
  if (!bankAccount) throw { statusCode: 400, message: 'No such bank account in this connection' };
  if (bankAccount.currency !== 'XXX' && bankAccount.currency !== account.currency) {
    throw {
      statusCode: 400,
      message: `The bank account is in ${bankAccount.currency} but the account is in ${account.currency}`,
    };
  }
}

/** Stores a link already passed through checkLink, or removes it (null). */
export async function applyLink(accountId: number, link: BankLinkInput | null): Promise<void> {
  if (link) await bankQueries.upsertLink(accountId, link.connectionId, link.uid);
  else await bankQueries.deleteLink(accountId);
}

/** Drops the links on the account whose connection belongs to the user, so nobody loads through their keys. */
export async function deleteLinksOfUser(tx: Tx, accountId: number, userId: number): Promise<void> {
  await bankQueries.deleteLinksOfUser(tx, accountId, userId);
}

/**
 * The account's bank transactions as an import preview. The window starts
 * at `dateFrom` (default today − 90) on the first load, two days before the
 * marker afterwards, and ends today (UTC). Uses the connection owner's keys.
 */
export async function loadFromBank(
  userId: number,
  accountId: number,
  opts: { dateFrom?: string; psu: PsuContext }
): Promise<ParseResult> {
  const account = await loadWritableAccount(accountId, userId);
  const [link] = await bankQueries.listLinks([accountId]);
  if (!link) throw notLinked();
  if (link.acc_uid === null) {
    throw { statusCode: 409, message: 'This bank account is no longer in the connection — link it again' };
  }
  if (link.acc_currency && link.acc_currency !== 'XXX' && link.acc_currency !== account.currency) {
    throw {
      statusCode: 409,
      message: `The bank account is in ${link.acc_currency} but the account is in ${account.currency} — link it again`,
    };
  }
  const status = connectionStatus(link);
  if (status === 'expired' || status === 'pending') throw accessExpired();
  const cred = await loadCredentials(link.user_id);

  const dateTo = todayUtc();
  if (opts.dateFrom && opts.dateFrom > dateTo) {
    throw { statusCode: 400, message: 'The start date is in the future' };
  }
  const dateFrom = link.loaded_to
    ? addDays(link.loaded_to, -OVERLAP_DAYS)
    : opts.dateFrom ?? addDays(dateTo, -FIRST_LOAD_DAYS);

  let txs: EbTransaction[];
  let balance: StoredBankBalance | null;
  try {
    txs = await fetchTransactions(cred, link.uid, dateFrom, dateTo, opts.psu);
    balance = await fetchBookedBalance(cred, link.uid, account.currency, opts.psu);
  } catch (error) {
    if (error instanceof BankAccessError) {
      await markExpired(link.connection_id);
      throw accessExpired();
    }
    throw error;
  }
  // A bank fact, whether or not the user goes on to confirm the rows.
  if (balance) await bankQueries.setBankBalance(accountId, balance);

  const rows = toParsedRows(txs, account.currency);
  const hashes = computeBankHashes(rows, { name: link.aspsp_name, country: link.aspsp_country });
  const result = await buildParseResult(userId, account, rows, hashes, 'enablebanking');
  return {
    ...result,
    bank: {
      aspspName: link.aspsp_name,
      dateFrom,
      dateTo,
      balance: balance && { amount: Number(balance.amount), type: balance.type, asOf: balance.asOf },
    },
  };
}

/** Booked balances only: available ones (ITAV, CLAV) include pending payments and credit limits. */
const BOOKED_TYPES = ['ITBD', 'CLBD'];

/**
 * The bank's booked balance in `currency`, or null when the bank reports
 * none or the call fails: the balance only backs a check, so its absence
 * never fails a load. A refused session still throws BankAccessError.
 */
async function fetchBookedBalance(
  cred: Parameters<typeof fetchBalances>[0],
  uid: string,
  currency: string,
  psu: PsuContext
): Promise<StoredBankBalance | null> {
  let balances: EbBalance[];
  try {
    balances = await fetchBalances(cred, uid, psu);
  } catch (error) {
    if (error instanceof BankAccessError) throw error;
    return null;
  }
  return pickBookedBalance(balances, currency);
}

export function pickBookedBalance(balances: EbBalance[], currency: string): StoredBankBalance | null {
  for (const type of BOOKED_TYPES) {
    const b = balances.find(
      (x) => x?.balance_type === type && x.balance_amount?.currency === currency
    );
    const amount = b?.balance_amount.amount;
    if (typeof amount !== 'string' || amount.trim() === '' || !Number.isFinite(Number(amount))) continue;
    const ref = b!.reference_date;
    return {
      amount: amount.trim(),
      type,
      asOf: ref && isIsoDate(ref) && ref <= todayUtc() ? ref : todayUtc(),
      fetchedAt: new Date().toISOString(),
    };
  }
  return null;
}

/** Moves the account's "loaded up to" marker forward to `date`; it never goes back. */
export async function advanceLoadedTo(accountId: number, date: string): Promise<void> {
  if (!(await bankQueries.advanceLoadedTo(accountId, date))) throw notLinked();
}
