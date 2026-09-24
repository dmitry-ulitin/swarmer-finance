-- 013_create_chain_seen_txids.sql
-- The on-chain transactions each tracked account's own sync has processed.
--
-- Sync pages an address's history newest first and stops at a page it has
-- fully seen. "Seen" cannot be read off the transactions table: a peer
-- wallet's sync can file a transfer into this account before this account
-- ever syncs, and counting that row as seen would stop paging early and skip
-- older history for good.
CREATE TABLE IF NOT EXISTS chain_seen_txids (
  account_id INTEGER NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  txid TEXT NOT NULL,
  PRIMARY KEY (account_id, txid)
);
