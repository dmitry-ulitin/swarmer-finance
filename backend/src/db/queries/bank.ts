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
