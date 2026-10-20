import { AccountMember } from '../types';
import { getAccountMembers, insertShare } from '../db/queries/accountShares';
import { getUserIdByEmail } from '../db/queries/users';
import { LEVEL, requireLevel } from './access';

export const listMembers = async (
  accountId: number,
  userId: number
): Promise<AccountMember[]> => {
  await requireLevel(accountId, userId, LEVEL.READ);
  return getAccountMembers(accountId);
};

export const addMember = async (
  accountId: number,
  userId: number,
  email: string,
  level: 1 | 2 | 3
): Promise<AccountMember[]> => {
  await requireLevel(accountId, userId, LEVEL.ADMIN);

  const targetId = await getUserIdByEmail(email.trim());
  if (targetId === null) {
    throw { statusCode: 404, message: 'No user with this email' };
  }
  if (targetId === userId) {
    throw { statusCode: 400, message: 'Cannot share an account with yourself' };
  }
  // The member list includes the creator, who has no share row.
  const members = await getAccountMembers(accountId);
  if (members.some(m => m.user_id === targetId)) {
    throw { statusCode: 409, message: 'This user already has access' };
  }

  await insertShare(accountId, targetId, level);
  return getAccountMembers(accountId);
};
