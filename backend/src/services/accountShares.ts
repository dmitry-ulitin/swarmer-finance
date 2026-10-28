import { AccountMember } from '../types';
import {
  deleteShare,
  getAccountMembers,
  getAuthoredCategoryIds,
  AuthorCategoryRemap,
  getEarliestCoOwner,
  getOthersRowsWithCategoriesOf,
  getShareLevel,
  insertShare,
  moveHistoryToOwner,
  remapAuthorCategories,
  transferOwnership,
  updateShareLevel,
} from '../db/queries/accountShares';
import { findOrCreateCategoryPath, getCategoryPath } from '../db/queries/categories';
import { withTransaction } from '../db';
import { getUserIdByEmail } from '../db/queries/users';
import { LEVEL, requireLevel } from './access';
import { deleteLinksOfUser } from './bank/links';
import { deleteUserSettings } from '../db/queries/accountUserSettings';

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

const NOT_A_MEMBER = { statusCode: 404, message: 'Not a member of this account' };

/**
 * Who takes over when the creator is removed or set below co-owner: the
 * co-owner acting, or — when the creator acts on themselves — the
 * earliest-granted remaining co-owner. A personal account has none.
 */
async function nextOwner(accountId: number, userId: number, creatorId: number): Promise<number> {
  const owner = userId !== creatorId ? userId : await getEarliestCoOwner(accountId, creatorId);
  if (owner === null) {
    throw { statusCode: 400, message: 'Delete the account instead' };
  }
  return owner;
}

export const setMemberLevel = async (
  accountId: number,
  userId: number,
  targetUserId: number,
  level: 1 | 2 | 3
): Promise<AccountMember[]> => {
  await requireLevel(accountId, userId, LEVEL.ADMIN);

  const creator = (await getAccountMembers(accountId)).find(m => m.is_creator)!;
  if (targetUserId === creator.user_id) {
    // A co-owned creator already resolves to 3.
    if (level === 3 && creator.level === 3) return getAccountMembers(accountId);
    const ownerId = await nextOwner(accountId, userId, creator.user_id);
    // The old creator keeps access, so their history stays theirs.
    await withTransaction(async tx => {
      await transferOwnership(tx, accountId, ownerId);
      await insertShare(accountId, creator.user_id, level, tx);
    });
    return getAccountMembers(accountId);
  }

  if ((await getShareLevel(accountId, targetUserId)) === null) {
    throw NOT_A_MEMBER;
  }
  await updateShareLevel(accountId, targetUserId, level);
  return getAccountMembers(accountId);
};

/**
 * Where each category of the departing member's rows should point once the
 * owner authors them. System categories and the owner's own stay; any other
 * (the member's, or a third party's they could use) is copied by path into
 * the owner's tree. Not resolveCategoryForOwner: its relation check would
 * refuse a third party's category and so block the removal.
 */
async function buildCategoryMap(
  accountId: number,
  fromUserId: number,
  ownerId: number
): Promise<Map<number, number>> {
  const map = new Map<number, number>();
  for (const cat of await getAuthoredCategoryIds(accountId, fromUserId)) {
    if (cat.user_id === null || cat.user_id === ownerId) continue;
    map.set(cat.id, await findOrCreateCategoryPath(ownerId, await getCategoryPath(cat.id)));
  }
  return map;
}

/**
 * Rows others entered on the account with the departing member's categories
 * (an import by a co-owner resolves categories against the creator) keep
 * their author; each category is copied by path into that author's tree,
 * since the departing member's categories leave the author's reach.
 */
async function buildAuthorRemaps(accountId: number, fromUserId: number): Promise<AuthorCategoryRemap[]> {
  const remaps: AuthorCategoryRemap[] = [];
  for (const row of await getOthersRowsWithCategoriesOf(accountId, fromUserId)) {
    const toId = await findOrCreateCategoryPath(row.author_id, await getCategoryPath(row.category_id));
    remaps.push({ authorId: row.author_id, fromId: row.category_id, toId });
  }
  return remaps;
}

/**
 * Revoke a member's access, or leave when the target is the caller. Their
 * expense/income rows on the account pass to the creator so the account's
 * history stays with someone who can still see and edit it. Removing the
 * creator moves ownership (see nextOwner) and their history with it.
 *
 * The member list is returned without an access check: a leaver no longer
 * has one but still gets a response.
 */
export const removeMember = async (
  accountId: number,
  userId: number,
  targetUserId: number
): Promise<AccountMember[]> => {
  await requireLevel(accountId, userId, targetUserId === userId ? LEVEL.READ : LEVEL.ADMIN);

  const members = await getAccountMembers(accountId);
  const creator = members.find(m => m.is_creator)!;
  if (targetUserId === creator.user_id) {
    const ownerId = await nextOwner(accountId, userId, creator.user_id);
    const creatorMap = await buildCategoryMap(accountId, creator.user_id, ownerId);
    const remaps = await buildAuthorRemaps(accountId, creator.user_id);
    await withTransaction(async tx => {
      await transferOwnership(tx, accountId, ownerId);
      await moveHistoryToOwner(tx, accountId, creator.user_id, ownerId, creatorMap);
      await remapAuthorCategories(tx, accountId, remaps);
      await deleteLinksOfUser(tx, accountId, creator.user_id);
      await deleteUserSettings(tx, accountId, creator.user_id);
    });
    return getAccountMembers(accountId);
  }
  if (!members.some(m => m.user_id === targetUserId)) {
    throw NOT_A_MEMBER;
  }

  // Built outside the transaction: copying a path is idempotent, so a copy
  // left behind by a failed removal is harmless.
  const categoryMap = await buildCategoryMap(accountId, targetUserId, creator.user_id);
  const remaps = await buildAuthorRemaps(accountId, targetUserId);
  await withTransaction(async tx => {
    await moveHistoryToOwner(tx, accountId, targetUserId, creator.user_id, categoryMap);
    await remapAuthorCategories(tx, accountId, remaps);
    await deleteShare(tx, accountId, targetUserId);
    await deleteLinksOfUser(tx, accountId, targetUserId);
    await deleteUserSettings(tx, accountId, targetUserId);
  });
  return getAccountMembers(accountId);
};
