-- 012_add_network_fees_category.sql
-- System category for blockchain network fees, filed by services/chainSync.ts.
--
-- No ON CONFLICT: migration 002 moved categories_id_seq to MAX(id) + 10, so
-- id 5 was never handed out. If it somehow is taken, the migration must fail
-- loudly rather than silently leave sync pointing at someone's category.
INSERT INTO categories (id, user_id, name, color, icon, parent_id)
VALUES (5, NULL, 'Network fees', '#888888', 'bitcoin', 2);
