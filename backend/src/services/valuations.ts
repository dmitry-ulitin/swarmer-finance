import { getAccountById } from '../db/queries/accounts';
import * as q from '../db/queries/valuations';
import { LEVEL, requireLevel } from './access';
import { toCents, toDecimal } from './currency';
import { todayUtc } from './date';

export interface ValuationDto {
  id: number;
  account_id: number;
  as_of: string;
  value: number;
  user_id: number;
  created_at: Date;
}

const toDto = (row: q.ValuationRow, scale: number): ValuationDto => ({
  id: row.id,
  account_id: row.account_id,
  as_of: row.as_of,
  value: toDecimal(row.value, scale),
  user_id: row.user_id,
  created_at: row.created_at,
});

const loadScale = async (accountId: number): Promise<number> => {
  const account = await getAccountById(accountId);
  if (!account || account.deleted) {
    throw { statusCode: 404, message: 'Account not found' };
  }
  return account.scale;
};

const checkDate = (asOf: string) => {
  if (asOf > todayUtc()) {
    throw { statusCode: 400, message: 'A valuation cannot be in the future' };
  }
};

const mapDuplicate = (error: unknown): never => {
  if ((error as { code?: string })?.code === '23505') {
    throw { statusCode: 409, message: 'A valuation for this date already exists' };
  }
  throw error;
};

export const listAccountValuations = async (
  accountId: number,
  userId: number
): Promise<ValuationDto[]> => {
  await requireLevel(accountId, userId, LEVEL.READ);
  const scale = await loadScale(accountId);
  return (await q.listValuations([accountId])).map((r) => toDto(r, scale));
};

export const createValuation = async (
  accountId: number,
  userId: number,
  input: { asOf: string; value: number }
): Promise<ValuationDto> => {
  await requireLevel(accountId, userId, LEVEL.WRITE);
  const scale = await loadScale(accountId);
  checkDate(input.asOf);
  try {
    const row = await q.insertValuation(accountId, input.asOf, toCents(input.value, scale), userId);
    return toDto(row, scale);
  } catch (error) {
    return mapDuplicate(error);
  }
};

export const updateValuation = async (
  accountId: number,
  valuationId: number,
  userId: number,
  input: { asOf: string; value: number }
): Promise<ValuationDto> => {
  await requireLevel(accountId, userId, LEVEL.WRITE);
  const scale = await loadScale(accountId);
  checkDate(input.asOf);
  try {
    const row = await q.updateValuation(accountId, valuationId, input.asOf, toCents(input.value, scale));
    if (!row) throw { statusCode: 404, message: 'Valuation not found' };
    return toDto(row, scale);
  } catch (error) {
    return mapDuplicate(error);
  }
};

export const deleteValuation = async (
  accountId: number,
  valuationId: number,
  userId: number
): Promise<void> => {
  await requireLevel(accountId, userId, LEVEL.WRITE);
  await loadScale(accountId);
  if (!(await q.deleteValuation(accountId, valuationId))) {
    throw { statusCode: 404, message: 'Valuation not found' };
  }
};
