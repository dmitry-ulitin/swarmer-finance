import * as categoryQueries from '../db/queries/categories';
import { getRelatedUserIds } from '../db/queries/accountShares';
import { Category } from '../types';

/**
 * Translate a PostgreSQL unique-constraint violation into a 409 Conflict
 * response. Returns the original error unchanged if it is not a unique
 * violation, so callers can rethrow.
 */
function isUniqueViolation(err: unknown): boolean {
  return (
    typeof err === 'object' &&
    err !== null &&
    'code' in err &&
    (err as { code?: string }).code === '23505'
  );
}

export const getCategoryTree = async (userId: number): Promise<Category[]> => {
  // The tree spans everyone whose categories can appear in transactions this
  // user can see, so a transaction authored by a co-owner resolves to a real
  // node instead of nothing. Each node carries owner_name, which is how the
  // client tells a foreign category apart from its own.
  const relatedUserIds = await getRelatedUserIds(userId);
  const allCategories = await categoryQueries.getCategoriesByUserIds(relatedUserIds);

  const systemRoots = allCategories.filter(c => c.user_id === null && c.parent_id === null);

  return systemRoots.map(root => ({
    ...root,
    children: buildTree(allCategories, root.id, userId),
  }));
};

/** The key a category is identified by in the tree: its root and its path. */
const pathKey = (rootId: number, fullName: string): string => `${rootId}\u0000${fullName}`;

/** The path a category's parent occupies, or '' when it sits under the root. */
const parentPath = (fullName: string): string => {
  const cut = fullName.lastIndexOf(' / ');
  return cut === -1 ? '' : fullName.slice(0, cut);
};

/**
 * The row that stands for each path, keyed by `pathKey`.
 *
 * Several users can own the same path — each keeps their own row, since
 * categories are per-user — but the tree shows one node per path. The
 * user's own row wins, otherwise the first the query returned (ordered by
 * id, so the oldest). System roots are not paths and are left out.
 */
const pathWinners = (categories: Category[], userId: number): Map<string, Category> => {
  const winners = new Map<string, Category>();
  for (const category of categories) {
    if (category.parent_id === null) continue;
    const key = pathKey(category.root_id, category.fullName);
    const current = winners.get(key);
    // Ownership outranks list order; among equals the first one stays.
    if (!current || (current.user_id !== userId && category.user_id === userId)) {
      winners.set(key, category);
    }
  }
  return winners;
};

/**
 * Every category id `userId` can meet in a transaction, mapped to the id
 * their tree shows for the same path. A co-owner's row at a path the user
 * also owns maps to the user's own row; ids outside the user's reach are
 * absent.
 */
export const getTreeCategoryIds = async (userId: number): Promise<Map<number, number>> => {
  const categories = await categoryQueries.getCategoriesByUserIds(await getRelatedUserIds(userId));
  const winners = pathWinners(categories, userId);
  return new Map(
    categories.map(c => [
      c.id,
      c.parent_id === null ? c.id : winners.get(pathKey(c.root_id, c.fullName))!.id,
    ])
  );
};

/**
 * The categories below one system root, keyed by path rather than by row
 * (see `pathWinners`). Nesting follows the path too: a node hangs off the
 * group whose path is its own minus the last segment, which is what lets
 * one user's child sit under another user's parent row.
 */
const buildTree = (categories: Category[], rootId: number, userId: number): Category[] => {
  const winners = new Map(
    [...pathWinners(categories, userId)].filter(([, c]) => c.root_id === rootId)
  );

  const childrenByParent = new Map<string, Category[]>();
  for (const category of winners.values()) {
    const parent = parentPath(category.fullName);
    // A path whose parent has no row among the winners is dropped, along
    // with its subtree — `attach` only descends into paths it has reached.
    //
    // This happens when a mid-path category belongs to someone the viewer
    // shares nothing with: A and C both share with B but not each other, C
    // owns "Food", B owns "Food / Snacks", so A sees the child and not its
    // parent. Hanging it off the root instead would show it at top level
    // while it still reports fullName "Food / Snacks" — a node whose
    // position contradicts its own label, and picking it as a parent then
    // rebuilds the full path somewhere the tree never showed it.
    //
    // The cost is that a transaction can stay visible while its category is
    // absent from the tree. The fuller fix is to synthesise placeholder
    // nodes for the missing ancestors (id: null, not selectable), which
    // keeps position and fullName in agreement without inventing access —
    // that needs Category.id to become nullable and both pickers to refuse
    // a placeholder, so it is left for later.
    if (parent !== '' && !winners.has(pathKey(rootId, parent))) {
      continue;
    }
    const siblings = childrenByParent.get(parent);
    if (siblings) siblings.push(category);
    else childrenByParent.set(parent, [category]);
  }

  const attach = (path: string): Category[] =>
    (childrenByParent.get(path) ?? [])
      .map(c => ({ ...c, children: attach(c.fullName) }))
      .sort((a, b) => a.user_id === null ? -1 : (b.user_id === null ? 1 : a.name.localeCompare(b.name)));

  return attach('');
};

/**
 * The category a transaction owned by `ownerId` should actually store when
 * the client sends `categoryId`.
 *
 * Categories are per-user, but the client is shown a tree spanning everyone
 * it shares accounts with, so `categoryId` may name a category someone else
 * owns. Rather than storing a foreign id, the same path is reproduced under
 * `ownerId` — found if it already exists, created otherwise. System
 * categories belong to everybody and pass through unchanged.
 *
 * Throws 403 when the category does not exist or belongs to a user the
 * owner shares nothing with.
 */
export const resolveCategoryForOwner = async (
  categoryId: number,
  ownerId: number
): Promise<number> => {
  const category = await categoryQueries.getCategoryById(categoryId);
  if (!category) {
    throw { statusCode: 403, message: 'Cannot use this category' };
  }
  // System categories (user_id IS NULL) are shared by everyone, and a
  // category the owner already holds needs no copy.
  if (category.user_id === null || category.user_id === ownerId) {
    return categoryId;
  }

  // The path is reproduced under `ownerId`, so it is the owner's reach that
  // bounds what may be borrowed — not the editor's. Checking the editor here
  // would let someone who can write on the owner's account copy a third
  // party's categories into a tree that never shared anything with them.
  const relatedUserIds = await getRelatedUserIds(ownerId);
  if (!relatedUserIds.includes(category.user_id)) {
    throw { statusCode: 403, message: 'Cannot use this category' };
  }

  const path = await categoryQueries.getCategoryPath(categoryId);
  // getCategoryPath returns [] when the id no longer exists — the category
  // can be deleted between the lookup above and this read. Treat it the same
  // as a category that was never there rather than letting the empty path
  // reach findOrCreateCategoryPath.
  if (path.length === 0) {
    throw { statusCode: 403, message: 'Cannot use this category' };
  }
  return categoryQueries.findOrCreateCategoryPath(ownerId, path);
};

export const createCategory = async (
  userId: number,
  name: string,
  parentId: number,
  color?: string,
  icon?: string
): Promise<Category> => {
  if (parentId === null) {
    throw { statusCode: 400, message: 'Cannot create root categories' };
  }
  
  const parentCategory = await categoryQueries.getCategoryById(parentId);
  if (!parentCategory) {
    throw { statusCode: 404, message: 'Parent category not found' };
  }

  // The tree shows one node per path, so the chosen parent may be a
  // co-owner's row. Reproduce its path under this user and create the child
  // there, rather than refusing or hanging a category off someone else's
  // row. A parent from an unrelated user is still rejected.
  const resolvedParentId = await resolveCategoryForOwner(parentId, userId);

  try {
    return await categoryQueries.createCategory(userId, name, resolvedParentId, color, icon);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw {
        statusCode: 409,
        message: `A sibling category named "${name}" already exists under this parent`,
      };
    }
    throw err;
  }
};

export const updateCategory = async (
  id: number,
  userId: number,
  name?: string,
  color?: string,
  icon?: string
): Promise<Category> => {
  if (id === 1 || id === 2 || id === 3 || id === 4 || id === 5) {
    throw { statusCode: 403, message: 'Cannot edit system categories' };
  }

  let updated: Category | null;
  try {
    updated = await categoryQueries.updateCategory(id, userId, name, color, icon);
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw {
        statusCode: 409,
        message: `A sibling category named "${name}" already exists under this parent`,
      };
    }
    throw err;
  }

  if (!updated) {
    throw { statusCode: 404, message: 'Category not found or not owned by user' };
  }

  return updated;
};

export const deleteCategory = async (id: number, userId: number): Promise<void> => {
  if (id === 1 || id === 2 || id === 3 || id === 4 || id === 5) {
    throw { statusCode: 403, message: 'Cannot delete system categories' };
  }
  
  const hasChildren = await categoryQueries.hasChildren(id);
  if (hasChildren) {
    throw { statusCode: 400, message: 'Cannot delete category with children' };
  }
  
  const deleted = await categoryQueries.deleteCategory(id, userId);
  if (!deleted) {
    throw { statusCode: 404, message: 'Category not found or not owned by user' };
  }
};
