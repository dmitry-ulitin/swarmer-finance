import { query, queryOne, execute, Tx } from '../index';

export interface BankCredentialsRow {
  user_id: number;
  application_id: string;
  private_key_enc: string;
}

export interface BankConnectionRow {
  id: number;
  user_id: number;
  aspsp_name: string;
  aspsp_country: string;
  session_id: string | null;
  valid_until: Date | null;
  expired: boolean;
  auth_state: string | null;
  auth_started_at: Date | null;
  created_at: Date;
}

export interface BankConnectionAccountRow {
  connection_id: number;
  uid: string;
  iban: string | null;
  name: string | null;
  currency: string;
}

export const getCredentials = (userId: number) =>
  queryOne<BankCredentialsRow>(
    'SELECT user_id, application_id, private_key_enc FROM bank_credentials WHERE user_id = $1',
    [userId]
  );

export const saveCredentials = (userId: number, applicationId: string, privateKeyEnc: string) =>
  execute(
    `INSERT INTO bank_credentials (user_id, application_id, private_key_enc)
     VALUES ($1, $2, $3)
     ON CONFLICT (user_id) DO UPDATE
       SET application_id = EXCLUDED.application_id,
           private_key_enc = EXCLUDED.private_key_enc,
           updated_at = now()`,
    [userId, applicationId, privateKeyEnc]
  );

export const deleteCredentials = (userId: number) =>
  execute('DELETE FROM bank_credentials WHERE user_id = $1', [userId]);

export const getConnection = (id: number) =>
  queryOne<BankConnectionRow>('SELECT * FROM bank_connections WHERE id = $1', [id]);

export const listConnections = (userId: number) =>
  query<BankConnectionRow>('SELECT * FROM bank_connections WHERE user_id = $1 ORDER BY id', [userId]);

export const listConnectionAccounts = (connectionIds: number[]) =>
  query<BankConnectionAccountRow>(
    `SELECT connection_id, uid, iban, name, currency FROM bank_connection_accounts
      WHERE connection_id = ANY($1) ORDER BY connection_id, uid`,
    [connectionIds]
  );

export const createPendingConnection = (userId: number, aspspName: string, country: string, state: string) =>
  queryOne<BankConnectionRow>(
    `INSERT INTO bank_connections (user_id, aspsp_name, aspsp_country, auth_state, auth_started_at)
     VALUES ($1, $2, $3, $4, now()) RETURNING *`,
    [userId, aspspName, country, state]
  );

export const setAuthState = (id: number, state: string) =>
  execute('UPDATE bank_connections SET auth_state = $2, auth_started_at = now() WHERE id = $1', [id, state]);

/** The caller's pending connection for `state`, if it was started under 30 minutes ago. */
export const findPendingByState = (userId: number, state: string) =>
  queryOne<BankConnectionRow>(
    `SELECT * FROM bank_connections
      WHERE auth_state = $1 AND user_id = $2
        AND auth_started_at > now() - interval '30 minutes'`,
    [state, userId]
  );

/**
 * Stores a completed consent, guarded by the state so a double submit
 * finishes only once; null when the state was already used.
 */
export const completeConnection = (
  tx: Tx,
  id: number,
  state: string,
  sessionId: string,
  validUntil: string
) =>
  tx.queryOne<BankConnectionRow>(
    `UPDATE bank_connections
        SET session_id = $3, valid_until = $4, expired = false,
            auth_state = NULL, auth_started_at = NULL
      WHERE id = $1 AND auth_state = $2
      RETURNING *`,
    [id, state, sessionId, validUntil]
  );

export const replaceConnectionAccounts = async (
  tx: Tx,
  connectionId: number,
  accounts: Omit<BankConnectionAccountRow, 'connection_id'>[]
) => {
  await tx.query('DELETE FROM bank_connection_accounts WHERE connection_id = $1', [connectionId]);
  for (const a of accounts) {
    await tx.query(
      `INSERT INTO bank_connection_accounts (connection_id, uid, iban, name, currency)
       VALUES ($1, $2, $3, $4, $5)`,
      [connectionId, a.uid, a.iban, a.name, a.currency]
    );
  }
};

export const markExpired = (id: number) =>
  execute('UPDATE bank_connections SET expired = true WHERE id = $1', [id]);

export const deleteConnection = (id: number) =>
  execute('DELETE FROM bank_connections WHERE id = $1', [id]);

export interface BankLinkRow {
  account_id: number;
  connection_id: number;
  uid: string;
  loaded_to: string | null;
  account_currency: string;
  user_id: number;
  session_id: string | null;
  valid_until: Date | null;
  expired: boolean;
  aspsp_name: string;
  aspsp_country: string;
  acc_uid: string | null;
  acc_iban: string | null;
  acc_name: string | null;
  acc_currency: string | null;
}

/** Links of the given accounts with their connection and, when still present, the bank account. */
export const listLinks = (accountIds: number[]) =>
  query<BankLinkRow>(
    `SELECT l.account_id, l.connection_id, l.uid, to_char(l.loaded_to, 'YYYY-MM-DD') AS loaded_to,
            a.currency AS account_currency,
            c.user_id, c.session_id, c.valid_until, c.expired, c.aspsp_name, c.aspsp_country,
            ca.uid AS acc_uid, ca.iban AS acc_iban, ca.name AS acc_name, ca.currency AS acc_currency
       FROM bank_account_links l
       JOIN accounts a ON a.id = l.account_id
       JOIN bank_connections c ON c.id = l.connection_id
       LEFT JOIN bank_connection_accounts ca ON ca.connection_id = l.connection_id AND ca.uid = l.uid
      WHERE l.account_id = ANY($1)`,
    [accountIds]
  );

export const hasLink = async (accountId: number) =>
  (await queryOne<{ one: number }>('SELECT 1 AS one FROM bank_account_links WHERE account_id = $1', [accountId])) !== null;

/** Sets the link; loaded_to survives only when it still points at the same bank account. */
export const upsertLink = (accountId: number, connectionId: number, uid: string) =>
  execute(
    `INSERT INTO bank_account_links (account_id, connection_id, uid)
     VALUES ($1, $2, $3)
     ON CONFLICT (account_id) DO UPDATE
       SET loaded_to = CASE WHEN bank_account_links.connection_id = EXCLUDED.connection_id
                             AND bank_account_links.uid = EXCLUDED.uid
                            THEN bank_account_links.loaded_to END,
           connection_id = EXCLUDED.connection_id,
           uid = EXCLUDED.uid`,
    [accountId, connectionId, uid]
  );

/** Moves loaded_to forward to `date`, never back; false when the account has no link. */
export const advanceLoadedTo = async (accountId: number, date: string) =>
  (await execute(
    `UPDATE bank_account_links SET loaded_to = GREATEST(COALESCE(loaded_to, $2::date), $2::date)
      WHERE account_id = $1`,
    [accountId, date]
  )) > 0;

export const deleteLink = (accountId: number) =>
  execute('DELETE FROM bank_account_links WHERE account_id = $1', [accountId]);

export const deleteLinksOfUser = (tx: Tx, accountId: number, userId: number) =>
  tx.query(
    `DELETE FROM bank_account_links
      WHERE account_id = $1
        AND connection_id IN (SELECT id FROM bank_connections WHERE user_id = $2)`,
    [accountId, userId]
  );
