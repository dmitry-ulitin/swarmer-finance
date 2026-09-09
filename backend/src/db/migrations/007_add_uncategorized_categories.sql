-- 007_add_uncategorized_categories.sql
ALTER TABLE categories DROP CONSTRAINT chk_system_root;
ALTER TABLE categories ADD CONSTRAINT chk_system_root CHECK (
  (user_id IS NULL AND parent_id IS NULL) OR
  (user_id IS NULL AND parent_id IS NOT NULL) OR
  (user_id IS NOT NULL AND parent_id IS NOT NULL)
);

-- Seed system "Uncategorized" categories under Income (1) and Expenses (2)
INSERT INTO categories (id, user_id, name, color, icon, parent_id) VALUES
  (3, NULL, 'Uncategorized', '#888888', 'circle-dashed', 1),
  (4, NULL, 'Uncategorized', '#888888', 'circle-dashed', 2)
ON CONFLICT (id) DO NOTHING;
