import jwt from 'jsonwebtoken';

export interface EbCredentials { applicationId: string; privateKey: string }
export interface EbAspsp {
  name: string;
  country: string;
  maximum_consent_validity?: number;
  beta?: boolean;
  psu_types?: string[];
}
export interface EbAccount {
  uid: string;
  account_id?: { iban?: string };
  currency: string;
  name?: string;
  product?: string;
}
export interface EbSession { session_id: string; access: { valid_until: string }; accounts: EbAccount[] }
export interface EbTransaction {
  entry_reference?: string | null;
  transaction_id?: string | null;
  transaction_amount: { amount: string; currency: string };
  credit_debit_indicator: 'DBIT' | 'CRDT';
  status: string;
  booking_date?: string | null;
  value_date?: string | null;
  transaction_date?: string | null;
  remittance_information?: string[] | null;
  creditor?: { name?: string | null } | null;
  debtor?: { name?: string | null } | null;
}
export interface PsuContext { ip?: string; userAgent?: string }

/** The bank session is no longer usable (expired or revoked consent). */
export class BankAccessError extends Error {
  constructor() {
    super('Bank access expired');
    this.name = 'BankAccessError';
  }
}

const TIMEOUT_MS = 10_000;
const MAX_PAGES = 50;

const baseUrl = () => (process.env.ENABLE_BANKING_API_URL || 'https://api.enablebanking.com').replace(/\/+$/, '');
const unavailable = () => ({ statusCode: 502, message: 'Bank API unavailable' });

/** `now` is unix seconds. */
export function makeJwt(cred: EbCredentials, now: number = Math.floor(Date.now() / 1000)): string {
  return jwt.sign(
    { iss: 'enablebanking.com', aud: 'api.enablebanking.com', iat: now, exp: now + 3600 },
    cred.privateKey,
    { algorithm: 'RS256', header: { typ: 'JWT', alg: 'RS256', kid: cred.applicationId } }
  );
}

async function call<T>(
  cred: EbCredentials,
  method: string,
  path: string,
  opts: { body?: unknown; psu?: PsuContext; accessErrors?: boolean } = {}
): Promise<T> {
  const headers: Record<string, string> = { Authorization: `Bearer ${makeJwt(cred)}` };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.psu?.ip) headers['Psu-Ip-Address'] = opts.psu.ip;
  if (opts.psu?.userAgent) headers['Psu-User-Agent'] = opts.psu.userAgent;

  let res: Response;
  try {
    res = await fetch(`${baseUrl()}${path}`, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch {
    throw unavailable();
  }
  if (res.status >= 500) throw unavailable();
  if (opts.accessErrors && (res.status === 401 || res.status === 403)) throw new BankAccessError();
  if (!res.ok) {
    let body: { message?: string; error?: string } = {};
    try {
      body = (await res.json()) ?? {};
    } catch {
      // no JSON body
    }
    throw { statusCode: 400, message: `Enable Banking: ${body.message ?? body.error ?? res.status}` };
  }
  if (res.status === 204) return undefined as T;
  try {
    return (await res.json()) as T;
  } catch {
    return undefined as T;
  }
}

export async function getAspsps(cred: EbCredentials, country: string): Promise<EbAspsp[]> {
  const res = await call<{ aspsps?: EbAspsp[] }>(cred, 'GET', `/aspsps?country=${encodeURIComponent(country)}`);
  return res?.aspsps ?? [];
}

export async function startAuth(
  cred: EbCredentials,
  req: { aspspName: string; country: string; validUntil: string; state: string; redirectUrl: string }
): Promise<{ url: string }> {
  const res = await call<{ url: string }>(cred, 'POST', '/auth', {
    body: {
      access: { valid_until: req.validUntil },
      aspsp: { name: req.aspspName, country: req.country },
      state: req.state,
      redirect_url: req.redirectUrl,
      psu_type: 'personal',
    },
  });
  return { url: res.url };
}

export function createSession(cred: EbCredentials, code: string): Promise<EbSession> {
  return call<EbSession>(cred, 'POST', '/sessions', { body: { code } });
}

export async function deleteSession(cred: EbCredentials, sessionId: string): Promise<void> {
  await call<void>(cred, 'DELETE', `/sessions/${encodeURIComponent(sessionId)}`);
}

export async function fetchTransactions(
  cred: EbCredentials,
  uid: string,
  dateFrom: string,
  dateTo: string,
  psu: PsuContext
): Promise<EbTransaction[]> {
  const rows: EbTransaction[] = [];
  let key: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const qs = new URLSearchParams({ date_from: dateFrom, date_to: dateTo });
    if (key) qs.set('continuation_key', key);
    const res = await call<{ transactions?: EbTransaction[]; continuation_key?: string | null }>(
      cred,
      'GET',
      `/accounts/${encodeURIComponent(uid)}/transactions?${qs}`,
      { psu, accessErrors: true }
    );
    rows.push(...(res?.transactions ?? []));
    if (!res?.continuation_key) return rows;
    key = res.continuation_key;
  }
  throw unavailable();
}
