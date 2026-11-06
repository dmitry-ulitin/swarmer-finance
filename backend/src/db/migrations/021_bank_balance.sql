-- The bank's latest booked balance for the linked account, as last fetched:
-- { "amount": "<decimal string>", "type": "ITBD" | "CLBD", "asOf": "YYYY-MM-DD", "fetchedAt": "<ISO>" }.
ALTER TABLE bank_account_links ADD COLUMN bank_balance JSONB;
