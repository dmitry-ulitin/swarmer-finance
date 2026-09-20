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
    children: buildTree(allCategories, root.id),
  }));
};

const buildTree = (categories: Category[], parentId: number): Category[] => {
  return categories
    .filter(c => c.parent_id === parentId)
    .map(c => ({
      ...c,
      children: buildTree(categories, c.id),
    }))
    .sort((a, b) => a.user_id === null ? -1 : (b.user_id === null ? 1 : a.name.localeCompare(b.name)));
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
 * caller shares nothing with.
 */
export const resolveCategoryForOwner = async (
  categoryId: number,
  ownerId: number,
  requestingUserId: number
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

  // A category may only be borrowed from someone the requesting user
  // actually shares accounts with.
  const relatedUserIds = await getRelatedUserIds(requestingUserId);
  if (!relatedUserIds.includes(category.user_id)) {
    throw { statusCode: 403, message: 'Cannot use this category' };
  }

  const path = await categoryQueries.getCategoryPath(categoryId);
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
  
  if (parentCategory.user_id !== null && parentCategory.user_id !== userId) {
    throw { statusCode: 403, message: 'Cannot create category under this parent' };
  }

  try {
    return await categoryQueries.createCategory(userId, name, parentId, color, icon);
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
  name: string,
  color?: string,
  icon?: string
): Promise<Category> => {
  if (id === 1 || id === 2 || id === 3 || id === 4) {
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
  if (id === 1 || id === 2 || id === 3 || id === 4) {
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
