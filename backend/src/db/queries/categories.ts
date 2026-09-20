import { query, queryOne, execute, withTransaction, Tx } from '../index';
import { Category } from '../../types';

/**
 * Every category with its display path and system root, derived once by
 * walking down from the roots. `full_name` excludes the root itself (a
 * category is already known to be income or expense), so a first-level
 * category's path is just its own name.
 *
 * Exported because transactions join it too: both the tree and a
 * transaction's category must report the same fullName and root_id.
 */
export const CATEGORY_PATHS_CTE = `
  WITH RECURSIVE category_paths AS (
    SELECT id, id AS root_id, ''::text AS full_name
    FROM categories WHERE parent_id IS NULL
    UNION ALL
    SELECT c.id, p.root_id,
           CASE WHEN p.full_name = '' THEN c.name ELSE p.full_name || ' / ' || c.name END
    FROM categories c JOIN category_paths p ON c.parent_id = p.id
  )
`;

/** One step of a category's ancestry, root first. */
export interface CategoryPathNode {
  id: number;
  name: string;
  parent_id: number | null;
  user_id: number | null;
  color: string;
  icon: string;
}

/**
 * A category's ancestry, ordered from the system root down to the category
 * itself. Returns [] when the id does not exist.
 */
export const getCategoryPath = async (id: number): Promise<CategoryPathNode[]> => {
  const rows = await query<CategoryPathNode & { depth: number }>(
    `WITH RECURSIVE ancestry AS (
       SELECT id, name, parent_id, user_id, color, icon, 0 AS depth
       FROM categories WHERE id = $1
       UNION ALL
       SELECT c.id, c.name, c.parent_id, c.user_id, c.color, c.icon, a.depth + 1
       FROM categories c JOIN ancestry a ON c.id = a.parent_id
     )
     SELECT * FROM ancestry ORDER BY depth DESC`,
    [id]
  );
  return rows.map(({ depth: _depth, ...node }) => node);
};

/**
 * Reproduce `path` under `userId` and return the id of its last node.
 *
 * `path` comes from getCategoryPath, so it starts at a system root — that
 * root is shared by every user and is used as-is. Each level below it is
 * matched by name among the user's own children of the level above, and
 * created (borrowing the source's color and icon) when absent. The whole
 * walk runs in one transaction so a failure part-way cannot leave a
 * half-built path behind.
 */
export const findOrCreateCategoryPath = async (
  userId: number,
  path: CategoryPathNode[]
): Promise<number> => {
  return withTransaction(async (tx: Tx) => {
    let parentId = path[0].id; // the system root, shared by all users
    for (const node of path.slice(1)) {
      const existing = await tx.queryOne<{ id: number }>(
        `SELECT id FROM categories
         WHERE parent_id = $1 AND name = $2 AND (user_id = $3 OR user_id IS NULL)
         ORDER BY user_id NULLS FIRST
         LIMIT 1`,
        [parentId, node.name, userId]
      );
      if (existing) {
        parentId = existing.id;
        continue;
      }
      const created = await tx.queryOne<{ id: number }>(
        `INSERT INTO categories (user_id, name, parent_id, color, icon)
         VALUES ($1, $2, $3, $4, $5) RETURNING id`,
        [userId, node.name, parentId, node.color, node.icon]
      );
      parentId = created!.id;
    }
    return parentId;
  });
};

/**
 * Categories owned by any of `userIds`, plus the system ones.
 *
 * Used for the tree a user is shown: it spans everyone whose categories can
 * appear in transactions they can see, not just their own.
 */
export const getCategoriesByUserIds = async (userIds: number[]): Promise<Category[]> => {
  return query<Category>(
    `${CATEGORY_PATHS_CTE}
     SELECT c.*, u.name AS owner_name,
            cp.full_name AS "fullName", cp.root_id
     FROM categories c
     LEFT JOIN users u ON u.id = c.user_id
     JOIN category_paths cp ON cp.id = c.id
     WHERE c.user_id = ANY($1::int[]) OR c.user_id IS NULL
     ORDER BY c.id`,
    [userIds]
  );
};

export const getCategoryById = async (id: number): Promise<Category | null> => {
  return queryOne<Category>(
    `${CATEGORY_PATHS_CTE}
     SELECT c.*, cp.full_name AS "fullName", cp.root_id
     FROM categories c
     JOIN category_paths cp ON cp.id = c.id
     WHERE c.id = $1`,
    [id]
  );
};

export const getUserCategories = async (userId: number): Promise<Category[]> => {
  return query<Category>(
    `${CATEGORY_PATHS_CTE}
     SELECT c.*, cp.full_name AS "fullName", cp.root_id
     FROM categories c
     JOIN category_paths cp ON cp.id = c.id
     WHERE c.user_id = $1
     ORDER BY c.parent_id NULLS FIRST, c.name`,
    [userId]
  );
};

export const createCategory = async (
  userId: number,
  name: string,
  parentId: number,
  color?: string,
  icon?: string
): Promise<Category> => {
  // Re-read through getCategoryById so the returned row carries fullName
  // and root_id, which RETURNING * cannot produce on its own.
  const result = await query<{ id: number }>(
    `INSERT INTO categories (user_id, name, parent_id, color, icon)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [userId, name, parentId, color || '#000000', icon || 'folder']
  );
  return (await getCategoryById(result[0].id))!;
};

export const updateCategory = async (
  id: number,
  userId: number,
  name: string,
  color?: string,
  icon?: string
): Promise<Category | null> => {
  // See createCategory: re-read to pick up fullName and root_id, which a
  // rename can change for this category and its descendants.
  const result = await query<{ id: number }>(
    `UPDATE categories SET name = $1, color = COALESCE($2, color), icon = COALESCE($3, icon)
     WHERE id = $4 AND user_id = $5 AND id NOT IN (1, 2, 3, 4) RETURNING id`,
    [name, color, icon, id, userId]
  );
  return result[0] ? await getCategoryById(result[0].id) : null;
};

export const deleteCategory = async (id: number, userId: number): Promise<boolean> => {
  if (id === 1 || id === 2 || id === 3 || id === 4) return false;
  const count = await execute(
    'DELETE FROM categories WHERE id = $1 AND user_id = $2 AND id NOT IN (1, 2, 3, 4)',
    [id, userId]
  );
  return count > 0;
};

export const hasChildren = async (categoryId: number): Promise<boolean> => {
  const result = await queryOne<{ count: string }>(
    'SELECT COUNT(*) as count FROM categories WHERE parent_id = $1',
    [categoryId]
  );
  return result ? parseInt(result.count, 10) > 0 : false;
};
