-- Emails are stored lowercase (routes/auth.ts); this keeps a differently
-- cased duplicate out even if one reaches the table some other way.
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_email_lower ON users (lower(email));
