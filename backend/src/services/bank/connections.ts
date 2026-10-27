import crypto from 'crypto';
import { withTransaction } from '../../db';
import * as bankQueries from '../../db/queries/bank';
import { BankConnectionRow } from '../../db/queries/bank';
import { decryptSecret, encryptSecret, isBankSyncEnabled } from './crypto';
import { EbAspsp, EbCredentials, createSession, deleteSession, getAspsps, startAuth } from './client';

const DAY_SECONDS = 86_400;
const MAX_CONSENT_DAYS = 180;
const EXPIRY_WARNING_MS = 7 * DAY_SECONDS * 1000;

export type BankConnectionStatus = 'pending' | 'active' | 'expiring' | 'expired';

export interface BankConnectionDto {
  id: number;
  aspspName: string;
  country: string;
  status: BankConnectionStatus;
  validUntil: string | null;
  accounts: { uid: string; iban: string | null; name: string | null; currency: string }[];
}

export interface BankCredentialsInfo {
  enabled: boolean;
  applicationId: string | null;
  hasKey: boolean;
}

export interface AspspDto {
  name: string;
  country: string;
  beta: boolean;
  maxConsentDays: number;
}

const unknownRequest = () => ({ statusCode: 400, message: 'Unknown or expired connection request' });

export async function getCredentialsInfo(userId: number): Promise<BankCredentialsInfo> {
  const row = await bankQueries.getCredentials(userId);
  return { enabled: isBankSyncEnabled(), applicationId: row?.application_id ?? null, hasKey: row !== null };
}

export async function saveCredentials(
  userId: number,
  applicationId: string,
  privateKey: string
): Promise<BankCredentialsInfo> {
  try {
    crypto.createPrivateKey(privateKey);
  } catch {
    // The parser's message is not passed on: it may quote the input.
    throw { statusCode: 400, message: 'Private key is not a valid PEM' };
  }
  await bankQueries.saveCredentials(userId, applicationId, encryptSecret(privateKey, userId));
  return getCredentialsInfo(userId);
}

export async function deleteCredentials(userId: number): Promise<void> {
  await bankQueries.deleteCredentials(userId);
}

export async function loadCredentials(userId: number): Promise<EbCredentials> {
  const row = await bankQueries.getCredentials(userId);
  if (!row) throw { statusCode: 400, message: 'Add your Enable Banking keys first' };
  return { applicationId: row.application_id, privateKey: decryptSecret(row.private_key_enc, userId) };
}

/** The bank's longest consent in days, capped at 180; 180 when it gives none. */
function consentDays(aspsp: EbAspsp): number {
  if (!aspsp.maximum_consent_validity) return MAX_CONSENT_DAYS;
  return Math.min(Math.floor(aspsp.maximum_consent_validity / DAY_SECONDS), MAX_CONSENT_DAYS);
}

export async function listAspsps(userId: number, country: string): Promise<AspspDto[]> {
  const cred = await loadCredentials(userId);
  return (await getAspsps(cred, country)).map((a) => ({
    name: a.name,
    country: a.country,
    beta: a.beta ?? false,
    maxConsentDays: consentDays(a),
  }));
}

export async function getConnection(userId: number, id: number): Promise<BankConnectionRow> {
  const row = await bankQueries.getConnection(id);
  if (!row || row.user_id !== userId) throw { statusCode: 404, message: 'Bank connection not found' };
  return row;
}

export async function markExpired(connectionId: number): Promise<void> {
  await bankQueries.markExpired(connectionId);
}

export function connectionStatus(
  c: Pick<BankConnectionRow, 'session_id' | 'valid_until' | 'expired'>
): BankConnectionStatus {
  if (!c.session_id) return 'pending';
  if (c.expired) return 'expired';
  if (!c.valid_until) return 'active';
  const left = new Date(c.valid_until).getTime() - Date.now();
  if (left <= 0) return 'expired';
  return left <= EXPIRY_WARNING_MS ? 'expiring' : 'active';
}

async function toDtos(rows: BankConnectionRow[]): Promise<BankConnectionDto[]> {
  const accounts = rows.length ? await bankQueries.listConnectionAccounts(rows.map((r) => r.id)) : [];
  return rows.map((r) => ({
    id: r.id,
    aspspName: r.aspsp_name,
    country: r.aspsp_country,
    status: connectionStatus(r),
    validUntil: r.valid_until ? new Date(r.valid_until).toISOString() : null,
    accounts: accounts
      .filter((a) => a.connection_id === r.id)
      .map((a) => ({ uid: a.uid, iban: a.iban, name: a.name, currency: a.currency })),
  }));
}

export async function listConnections(userId: number): Promise<BankConnectionDto[]> {
  return toDtos(await bankQueries.listConnections(userId));
}

/** Asks the bank for a consent with a fresh one-time state; returns where to send the user. */
async function requestConsent(
  cred: EbCredentials,
  aspspName: string,
  country: string,
  redirectUrl: string,
  saveState: (state: string) => Promise<unknown>
): Promise<{ url: string }> {
  const aspsp = (await getAspsps(cred, country)).find((a) => a.name === aspspName);
  if (!aspsp) throw { statusCode: 400, message: 'Bank not found' };
  const state = crypto.randomBytes(24).toString('hex');
  await saveState(state);
  const validUntil = new Date(Date.now() + consentDays(aspsp) * DAY_SECONDS * 1000).toISOString();
  return startAuth(cred, { aspspName, country, validUntil, state, redirectUrl });
}

export async function startConnection(
  userId: number,
  aspspName: string,
  country: string,
  redirectUrl: string
): Promise<{ url: string }> {
  const cred = await loadCredentials(userId);
  return requestConsent(cred, aspspName, country, redirectUrl, (state) =>
    bankQueries.createPendingConnection(userId, aspspName, country, state)
  );
}

export async function reconnect(userId: number, id: number, redirectUrl: string): Promise<{ url: string }> {
  const conn = await getConnection(userId, id);
  const cred = await loadCredentials(userId);
  return requestConsent(cred, conn.aspsp_name, conn.aspsp_country, redirectUrl, (state) =>
    bankQueries.setAuthState(id, state)
  );
}

export async function completeConnection(userId: number, state: string, code: string): Promise<BankConnectionDto> {
  const pending = await bankQueries.findPendingByState(userId, state);
  if (!pending) throw unknownRequest();
  const cred = await loadCredentials(userId);
  const session = await createSession(cred, code);

  const updated = await withTransaction(async (tx) => {
    const row = await bankQueries.completeConnection(
      tx,
      pending.id,
      state,
      session.session_id,
      session.access.valid_until
    );
    if (!row) throw unknownRequest();
    await bankQueries.replaceConnectionAccounts(
      tx,
      row.id,
      (session.accounts ?? []).map((a) => ({
        uid: a.uid,
        iban: a.account_id?.iban ?? null,
        name: a.name ?? null,
        currency: a.currency,
      }))
    );
    return row;
  });

  if (pending.session_id && pending.session_id !== session.session_id) {
    await deleteSession(cred, pending.session_id).catch(() => undefined);
  }
  return (await toDtos([updated]))[0];
}

export async function deleteConnection(userId: number, id: number): Promise<void> {
  const conn = await getConnection(userId, id);
  if (conn.session_id) {
    try {
      await deleteSession(await loadCredentials(userId), conn.session_id);
    } catch {
      // Best effort: the consent lapses at the bank anyway.
    }
  }
  await bankQueries.deleteConnection(id);
}
