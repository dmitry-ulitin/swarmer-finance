-- 005_unique_sibling_categories.sql
-- Enforce uniqueness of sibling category names per user. Two user-owned
-- categories with the same (user_id, parent_id, name) tuple are forbidden —
-- they would render as ambiguous entries in the category tree and confuse
-- the rename-collision test in categories.test.ts.
--
-- The partial index excludes system roots (user_id IS NULL) so the seeded
-- "Income" and "Expenses" rows are not constrained, and a future third
-- system root can also be added without violating the constraint.
CREATE UNIQUE INDEX IF NOT EXISTS uq_categories_sibling
  ON categories (user_id, parent_id, name)
  WHERE user_id IS NOT NULL;