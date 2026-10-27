import { Tx } from '../../db';
import * as bankQueries from '../../db/queries/bank';
import { BankLinkRow } from '../../db/queries/bank';
import { getAccountById } from '../../db/queries/accounts';
import { LEVEL, requireLevel } from '../access';
import { BankConnectionStatus, connectionStatus, getConnection, loadCredentials, markExpired } from './connections';
import { BankAccessError, EbTransaction, PsuContext, fetchTransactions } from './client';
import { computeBankHashes, toParsedRows } from './rows';
import { ParseResult, buildParseResult, loadWritableAccount } from '../import';
import { addDays, todayUtc } from '../date';

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
  try {
    txs = await fetchTransactions(cred, link.uid, dateFrom, dateTo, opts.psu);
  } catch (error) {
    if (error instanceof BankAccessError) {
      await markExpired(link.connection_id);
      throw accessExpired();
    }
    throw error;
  }

  const rows = toParsedRows(txs, account.currency);
  const hashes = computeBankHashes(rows, { name: link.aspsp_name, country: link.aspsp_country });
  const result = await buildParseResult(userId, account, rows, hashes, 'enablebanking');
  return { ...result, bank: { aspspName: link.aspsp_name, dateFrom, dateTo } };
}

/** Moves the account's "loaded up to" marker forward to `date`; it never goes back. */
export async function advanceLoadedTo(accountId: number, date: string): Promise<void> {
  if (!(await bankQueries.advanceLoadedTo(accountId, date))) throw notLinked();
}
