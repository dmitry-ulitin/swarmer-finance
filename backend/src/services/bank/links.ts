import { Tx } from '../../db';
import * as bankQueries from '../../db/queries/bank';
import { BankLinkRow } from '../../db/queries/bank';
import { getAccountById } from '../../db/queries/accounts';
import { LEVEL, requireLevel } from '../access';
import { BankConnectionStatus, connectionStatus, getConnection } from './connections';

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

export async function setLink(
  accountId: number,
  userId: number,
  connectionId: number,
  uid: string
): Promise<BankLinkDto> {
  await requireLevel(accountId, userId, LEVEL.ADMIN);
  const account = await getAccountById(accountId);
  if (!account || account.deleted) throw { statusCode: 404, message: 'Account not found' };
  if (account.type !== 'bank') {
    throw { statusCode: 400, message: 'Only a bank account can be linked to a bank' };
  }
  await getConnection(userId, connectionId);
  const bankAccount = (await bankQueries.listConnectionAccounts([connectionId])).find((a) => a.uid === uid);
  if (!bankAccount) throw { statusCode: 400, message: 'No such bank account in this connection' };
  if (bankAccount.currency !== 'XXX' && bankAccount.currency !== account.currency) {
    throw {
      statusCode: 400,
      message: `The bank account is in ${bankAccount.currency} but the account is in ${account.currency}`,
    };
  }
  await bankQueries.upsertLink(accountId, connectionId, uid);
  return (await getLinkDtos([accountId], userId)).get(accountId)!;
}

export async function removeLink(accountId: number, userId: number): Promise<void> {
  await requireLevel(accountId, userId, LEVEL.ADMIN);
  await bankQueries.deleteLink(accountId);
}

/** Drops the links on the account whose connection belongs to the user, so nobody loads through their keys. */
export async function deleteLinksOfUser(tx: Tx, accountId: number, userId: number): Promise<void> {
  await bankQueries.deleteLinksOfUser(tx, accountId, userId);
}
