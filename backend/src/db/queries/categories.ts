import { query, queryOne, execute } from '../index';
import { Category } from '../../types';

export const getCategoriesByUserId = async (userId: number): Promise<Category[]> => {
  return query<Category>(
    'SELECT * FROM categories WHERE user_id = $1 OR user_id IS NULL ORDER BY id',
    [userId]
  );
};

export const getCategoryById = async (id: number): Promise<Category | null> => {
  return queryOne<Category>('SELECT * FROM categories WHERE id = $1', [id]);
};

export const getUserCategories = async (userId: number): Promise<Category[]> => {
  return query<Category>(
    'SELECT * FROM categories WHERE user_id = $1 ORDER BY parent_id NULLS FIRST, name',
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
  const result = await query<Category>(
    `INSERT INTO categories (user_id, name, parent_id, color, icon) 
     VALUES ($1, $2, $3, $4, $5) RETURNING *`,
    [userId, name, parentId, color || '#000000', icon || 'folder']
  );
  return result[0];
};

export const updateCategory = async (
  id: number,
  userId: number,
  name: string,
  color?: string,
  icon?: string
): Promise<Category | null> => {
  const result = await query<Category>(
    `UPDATE categories SET name = $1, color = COALESCE($2, color), icon = COALESCE($3, icon)
     WHERE id = $4 AND user_id = $5 AND id NOT IN (1, 2, 3, 4) RETURNING *`,
    [name, color, icon, id, userId]
  );
  return result[0] || null;
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

export const canUserAccessCategory = async (
  categoryId: number,
  userId: number
): Promise<boolean> => {
  const category = await queryOne<Category>(
    'SELECT * FROM categories WHERE id = $1',
    [categoryId]
  );
  
  if (!category) return false;
  if (category.user_id === null) return true;
  return category.user_id === userId;
};
