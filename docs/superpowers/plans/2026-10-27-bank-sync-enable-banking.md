# Bank Sync via Enable Banking Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A bank account linked to a PSD2 bank through the user's own Enable
Banking app gets "Load from bank", which feeds the bank's booked transactions
into the existing import preview (`import-review`) and saves them through the
existing `reconcile`.

**Architecture:** A new backend module `services/bank/` holds the encrypted
per-user keys, the Enable Banking HTTP client (modelled on
`services/chain/*`), the mapping of bank transactions to `ParsedRow`, and the
connections/links services. `parseStatement` is split, so a file and a bank
both produce `ParsedRow[]` and share one `buildParseResult`. `reconcile`
gains an optional `bankLoadedTo` that moves the link's "loaded up to" marker.
The frontend adds a "Bank connections" dialog (keys + connected banks), a
`/bank-callback` route, a link dialog, and a "Load from bank" action that
opens the existing review dialog.

**Tech Stack:** Express 5, Zod 4, `pg` raw SQL, `jsonwebtoken` (RS256),
Node `crypto` (AES-256-GCM), Jest + supertest; Angular 22 standalone/OnPush/
signals, Taiga UI v5, Vitest via `ng test`.

**Spec:** `docs/superpowers/specs/2026-10-23-bank-sync-enable-banking-design.md`

**Changes since the spec was approved** (decided while planning, 2026-10-27):
- Keys are entered in a "Bank connections" dialog opened from the user
  dropdown in the header (next to Profile / Change password). The profile is
  a dialog, not a page; a separate dialog keeps the profile form simple.
- One Enable Banking registration per user: an Application ID (the
  registration's identifier, the JWT `kid`) and its private key. The server's
  `BANK_CREDENTIALS_KEY` is not a user key: it only encrypts the stored ones.
- The redirect URL is not stored: the frontend sends
  `${location.origin}/bank-callback` when it starts a consent. In prod that is
  the Render static site's `https://…/bank-callback`, which the user registers
  in their Enable Banking app in place of the GitHub page. No "paste the
  address" fallback (user's decision, 2026-10-27): a consent cannot be
  completed against a local, non-https frontend; local work relies on the
  mocked tests, and the manual check runs on prod.

## Global Constraints

- Envelope `{ data, error }`; errors are thrown as `{ statusCode, message }`.
- Next migration is `018_create_bank_sync.sql`.
- `BANK_CREDENTIALS_KEY`: 32 random bytes, base64. Unset or not 32 bytes:
  every `/api/bank/*` call except `GET /api/bank/credentials`, and
  `POST /api/import/bank`, return 503 `Bank sync is not configured`, and
  `GET /api/bank/credentials` returns `{ enabled: false, … }`. The server
  never crashes because of it.
- The private key never appears in an API response, a log line, an error
  message, or the DB as plain text. Encrypt with AES-256-GCM, AAD
  `user:<userId>`.
- Enable Banking base URL `ENABLE_BANKING_API_URL`, default
  `https://api.enablebanking.com`.
- JWT for Enable Banking: RS256, header `{ typ: 'JWT', alg: 'RS256', kid: <applicationId> }`,
  payload `{ iss: 'enablebanking.com', aud: 'api.enablebanking.com', iat, exp }`, `exp = iat + 3600`.
- Consent validity requested: the bank's `maximum_consent_validity`
  (seconds) from `/aspsps`, capped at 180 days.
- Only `status: 'BOOK'` transactions are imported.
- Hash: `sha256("eb|<country>|<aspsp name>|<entry_reference>")`; else
  `transaction_id` in its place; else the content hash with
  `eb|<country>|<aspsp name>` where `computeImportHashes` puts the profile id.
- Date window: no marker → `dateFrom` from the user (default today − 90 days);
  marker X → `X − 2 days`; `dateTo` = today (UTC). All pages via
  `continuation_key`.
- The marker moves to `dateTo` only on a successful confirm, including a
  confirm with zero rows; it never moves backwards.
- Expiry warning: 7 days before `valid_until`.
- Linking an account needs ADMIN on it, and the connection must be the
  caller's. Loading needs WRITE. Only an account of type `bank` can be
  linked (user's decision, 2026-10-27; this also rules out tracked wallets),
  and a linked account cannot change its type.
- Enable Banking calls are mocked in tests by replacing `global.fetch`, as
  `syncApi.test.ts` does.
- UI copy is English (as in the rest of the app).

## Review Focus

1. **Reconnect returns new `uid`s.** Links whose `uid` is not among the new
   session's accounts must stay visible as "needs relinking", and loading one
   must answer 409 `This bank account is no longer in the connection — link it again`,
   never fetch with a stale uid or silently load nothing. Test in Task 6.
2. **Multi-currency `XXX` account linked to a USD app account.** Only USD
   rows come in; a window with only EUR rows returns 0 rows without an error
   and still lets the marker move. A single-currency bank account in another
   currency than the app account is refused at link time (400). Tests in
   Tasks 3 and 6.
3. **Key leakage through errors.** A malformed PEM on save → 400 `Private key is not a valid PEM`
   (the PEM is not echoed); an Enable Banking error message is passed through,
   but the request's JWT or key never is. Test in Task 5.
4. **A stale or foreign `state` on `/bank-callback`** (double-submit, a
   callback from the prod app while testing locally, another user's state)
   → 400 `Unknown or expired connection request`, nothing changes, and the
   frontend shows the message. Test in Tasks 5 and 9.
5. **The connection owner loses access to the shared account** (removed,
   or leaves). Their link on that account is deleted in the same
   `removeMember` transaction, so nobody else loads through a stranger's keys.
   Test in Task 6.

---

## File Structure

Backend:
- `backend/src/db/migrations/018_create_bank_sync.sql` — four tables.
- `backend/src/db/queries/bank.ts` — raw SQL for them.
- `backend/src/services/bank/crypto.ts` — master key, encrypt/decrypt.
- `backend/src/services/bank/client.ts` — Enable Banking HTTP client.
- `backend/src/services/bank/rows.ts` — bank transaction → `ParsedRow`, hashes.
- `backend/src/services/bank/connections.ts` — keys, banks list, connect/complete/reconnect/delete.
- `backend/src/services/bank/links.ts` — link/unlink, link DTO, load, marker.
- `backend/src/routes/bank.ts` — `/api/bank/*`.
- Modified: `services/import/hash.ts`, `services/import/index.ts`,
  `routes/import.ts`, `services/accounts.ts`, `services/accountShares.ts`,
  `types/index.ts`, `index.ts`, `test/testApp.ts`,
  `.env.example`, `render.yaml`, `CLAUDE.md`.

Frontend:
- `frontend/src/app/models/bank.ts`
- `frontend/src/app/features/bank/bank-dialog.service.ts`
- `frontend/src/app/features/bank/bank-connections/` — keys + connections dialog.
- `frontend/src/app/features/bank/bank-callback/` — route component.
- `frontend/src/app/features/bank/bank-link/` — link dialog.
- `frontend/src/app/features/bank/bank-load/` — first-load date dialog.
- Modified: `models/account.ts`, `models/import.ts`, `core/api.service.ts`,
  `app.routes.ts`, `features/header/header.{ts,html}`,
  `features/import/import-dialog.service.ts`,
  `features/import/import-review/import-review.{ts,html}`.

---

### Task 1: Schema and key encryption

**Files:**
- Create: `backend/src/db/migrations/018_create_bank_sync.sql`
- Create: `backend/src/services/bank/crypto.ts`
- Modify: `.env.example`, `render.yaml`
- Test: `backend/src/test/bankCrypto.test.ts`

**Interfaces:**
- Produces:
  - `isBankSyncEnabled(): boolean`
  - `requireBankSync(): void` — throws `{ statusCode: 503, message: 'Bank sync is not configured' }`
  - `encryptSecret(plain: string, userId: number): string` — format `v1.<iv b64>.<tag b64>.<ciphertext b64>`, 12-byte random IV
  - `decryptSecret(stored: string, userId: number): string` — throws `{ statusCode: 500, message: 'Stored bank key cannot be decrypted' }` on any failure
  - Tables (below), used by Task 4 onward.

Migration (exact columns; constraints matter, comments in the style of 013):

```sql
CREATE TABLE IF NOT EXISTS bank_credentials (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  application_id TEXT NOT NULL,
  private_key_enc TEXT NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS bank_connections (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  aspsp_name TEXT NOT NULL,
  aspsp_country CHAR(2) NOT NULL,
  session_id TEXT,                 -- null until the first consent completes
  valid_until TIMESTAMPTZ,
  expired BOOLEAN NOT NULL DEFAULT false,   -- the bank refused the session
  auth_state TEXT UNIQUE,          -- one-time, null when no consent is pending
  auth_started_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS bank_connection_accounts (
  connection_id INTEGER NOT NULL REFERENCES bank_connections(id) ON DELETE CASCADE,
  uid TEXT NOT NULL,
  iban TEXT,
  name TEXT,
  currency TEXT NOT NULL,          -- 'XXX' = multi-currency
  PRIMARY KEY (connection_id, uid)
);
CREATE TABLE IF NOT EXISTS bank_account_links (
  account_id INTEGER PRIMARY KEY REFERENCES accounts(id) ON DELETE CASCADE,
  connection_id INTEGER NOT NULL REFERENCES bank_connections(id) ON DELETE CASCADE,
  uid TEXT NOT NULL,               -- deliberately no FK: survives a reconnect that drops the uid
  loaded_to DATE
);
```

- [ ] **Step 1: Write the failing tests** in `bankCrypto.test.ts` (set `process.env.BANK_CREDENTIALS_KEY` to `crypto.randomBytes(32).toString('base64')` in `beforeEach`, restore after):
  - `round-trips a PEM`: `decryptSecret(encryptSecret(pem, 7), 7) === pem`; the stored string starts with `v1.` and does not contain `BEGIN`.
  - `uses a fresh IV`: two encryptions of the same text differ.
  - `refuses another user's ciphertext`: `decryptSecret(encryptSecret(pem, 7), 8)` rejects with statusCode 500.
  - `refuses a tampered ciphertext`: flip one char of the ciphertext part → 500.
  - `is disabled without a key or with a short one`: unset → `isBankSyncEnabled() === false`, `requireBankSync` throws 503; 16-byte key → also disabled.
- [ ] **Step 2:** Run `cd backend && npx jest --testPathPatterns=bankCrypto` — FAIL (module missing).
- [ ] **Step 3:** Write the migration and `crypto.ts` (read the env var on every call, not at import, so tests can toggle it). Run `npm run migrate` against the dev DB and the test DB.
- [ ] **Step 4:** Add to `.env.example` a commented `BANK_CREDENTIALS_KEY=` (how to generate: `openssl rand -base64 32`; unset turns bank sync off) and `ENABLE_BANKING_API_URL=https://api.enablebanking.com`; add `- key: BANK_CREDENTIALS_KEY` with `sync: false` to `render.yaml` (not `generateValue`: losing it on a Blueprint re-create would make stored keys undecryptable).
- [ ] **Step 5:** Run the test — PASS. Commit `feat(bank): schema and encrypted key storage`.

---

### Task 2: Enable Banking client

**Files:**
- Create: `backend/src/services/bank/client.ts`
- Create: `backend/src/test/fixtures/enablebanking/` — `aspsps-ee.json`, `session.json`, `transactions-page1.json`, `transactions-page2.json` (hand-made, anonymised, in the shape the spec's probe recorded)
- Test: `backend/src/test/bankClient.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface EbCredentials { applicationId: string; privateKey: string }
  export interface EbAspsp { name: string; country: string; maximum_consent_validity?: number; beta?: boolean; psu_types?: string[] }
  export interface EbAccount { uid: string; account_id?: { iban?: string }; currency: string; name?: string; product?: string }
  export interface EbSession { session_id: string; access: { valid_until: string }; accounts: EbAccount[] }
  export interface EbTransaction {
    entry_reference?: string | null; transaction_id?: string | null;
    transaction_amount: { amount: string; currency: string };
    credit_debit_indicator: 'DBIT' | 'CRDT'; status: string;
    booking_date?: string | null; value_date?: string | null; transaction_date?: string | null;
    remittance_information?: string[] | null;
    creditor?: { name?: string | null } | null; debtor?: { name?: string | null } | null;
  }
  export interface PsuContext { ip?: string; userAgent?: string }
  export function makeJwt(cred: EbCredentials, now?: number): string
  export function getAspsps(cred: EbCredentials, country: string): Promise<EbAspsp[]>
  export function startAuth(cred: EbCredentials, req: { aspspName: string; country: string; validUntil: string; state: string; redirectUrl: string }): Promise<{ url: string }>
  export function createSession(cred: EbCredentials, code: string): Promise<EbSession>
  export function deleteSession(cred: EbCredentials, sessionId: string): Promise<void>
  export function fetchTransactions(cred: EbCredentials, uid: string, dateFrom: string, dateTo: string, psu: PsuContext): Promise<EbTransaction[]>
  export class BankAccessError extends Error {}   // the session is no longer usable
  ```
- Errors: network failure / timeout (10 s) / 5xx → `{ statusCode: 502, message: 'Bank API unavailable' }`. On `fetchTransactions`, 401/403 → `throw new BankAccessError()`. Any other non-2xx → `{ statusCode: 400, message: 'Enable Banking: <body.message ?? body.error ?? status>' }`.
- Requests: `Authorization: Bearer <jwt>`; `POST /auth` body per the spec (`access.valid_until`, `aspsp {name, country}`, `state`, `redirect_url`, `psu_type: 'personal'`); `POST /sessions {code}`; `GET /aspsps?country=`; `GET /accounts/{uid}/transactions?date_from&date_to[&continuation_key]` with `Psu-Ip-Address` / `Psu-User-Agent` when given (check the Enable Banking docs for the exact header names before coding; the spec leaves this to the builder, the plan's call is to send them); `DELETE /sessions/{id}`.
- Paging stops when `continuation_key` is absent or empty; more than 50 pages → 502 (a loop guard, not a real limit).

- [ ] **Step 1: Write the failing tests** (generate an RSA key with `crypto.generateKeyPairSync('rsa', { modulusLength: 2048 })` in the test, export PKCS#8 PEM):
  - `signs an RS256 JWT with the application id as kid`: `jwt.verify(makeJwt(cred, 1000), publicKey, { algorithms: ['RS256'] })` gives `iss 'enablebanking.com'`, `aud 'api.enablebanking.com'`, `iat 1000`, `exp 4600`; decoded header `kid` = application id.
  - `lists banks of a country`: fetch mocked with `aspsps-ee.json` → URL ends `/aspsps?country=EE`, result names include `LHV Pank`.
  - `follows continuation_key`: page1 (with key `k2`) then page2 → all rows of both, second URL contains `continuation_key=k2`, both carry `Psu-User-Agent`.
  - `maps 401 on transactions to BankAccessError` and `maps 500 to 502`.
  - `passes the Enable Banking message on other errors`: 403 on `/aspsps` with `{ message: 'Application is not active' }` → 400 `Enable Banking: Application is not active`; the thrown message does not contain `Bearer`.
- [ ] **Step 2:** `npx jest --testPathPatterns=bankClient` — FAIL.
- [ ] **Step 3:** Implement `client.ts` (`jsonwebtoken` is already a dependency; `fetch` with `AbortSignal.timeout(10_000)`, like the chain providers).
- [ ] **Step 4:** Run — PASS. Commit `feat(bank): Enable Banking client`.

---

### Task 3: Bank rows and hashes

**Files:**
- Create: `backend/src/services/bank/rows.ts`
- Modify: `backend/src/services/import/hash.ts`
- Test: `backend/src/test/bankRows.test.ts`

**Interfaces:**
- Consumes: `EbTransaction` (Task 2), `ParsedRow` (`services/import/rows.ts`).
- Produces:
  - `hashRows(rows: ParsedRow[], namespace: string, useReference: boolean): string[]` in `hash.ts`; `computeImportHashes(rows, profile)` becomes `hashRows(rows, profile.id, profile.identity.kind === 'reference')` — byte-identical output for existing profiles.
  - `toParsedRows(txs: EbTransaction[], currency: string): ParsedRow[]` — BOOK only, currency equal to `currency` only, `index` contiguous over the survivors; `reference = entry_reference || transaction_id || null`; field mapping exactly as the spec's "Отображение полей"; amount parsed with `Number`, rounded to 2 decimals like `round2`; zero amounts dropped.
  - `computeBankHashes(rows: ParsedRow[], aspsp: { name: string; country: string }): string[]` = `hashRows(rows, \`eb|${country}|${name}\`, true)`.

- [ ] **Step 1: Write the failing tests:**
  - `maps a DBIT card row`: `{amount:'12.30', DBIT, BOOK, booking_date:'2026-10-12', remittance_information:['(..7101) 2026-10-11 KFC', 'TALLINN']}` → `{ date:'2026-10-12', amount:-12.3, description:'(..7101) 2026-10-11 KFC TALLINN', payee:null }`.
  - `takes the payee from the counterparty side`: DBIT with `creditor.name 'Elektrilevi'` → payee `Elektrilevi`; CRDT with `debtor.name 'Employer OÜ'` → payee `Employer OÜ`, positive amount.
  - `falls back from booking_date to value_date then transaction_date`.
  - `drops PDNG rows and other currencies`: rows in `EUR`, `USD`, one `PDNG` EUR; `toParsedRows(rows, 'USD')` → only the USD row with `index 0`.
  - `hashes by entry_reference`: equals `sha256('eb|EE|LHV Pank|ref-1')` hex.
  - `falls back to transaction_id, then content`: two identical rows without either reference get different hashes (occurrence index); the first equals what `hashRows` gives for namespace `eb|EE|LHV Pank` with `useReference` true and `reference: null`.
  - `keeps CSV hashes unchanged`: run the existing `importHash*.test.ts` suites unmodified.
- [ ] **Step 2:** `npx jest --testPathPatterns="bankRows|importHash"` — bankRows FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run — all PASS. Commit `feat(bank): map bank transactions to import rows`.

---

### Task 4: Split `parseStatement`

**Files:**
- Modify: `backend/src/services/import/index.ts`

**Interfaces:**
- Produces (exported from `services/import/index.ts`):
  - `loadWritableAccount(accountId: number, userId: number): Promise<Account>` — now exported, unchanged.
  - `buildParseResult(userId: number, account: Account, rows: ParsedRow[], hashes: string[], format: string, categoryKeys?: KeyField[]): Promise<ParseResult>` — everything `parseStatement` does after `computeImportHashes`: exact and advisory duplicates, suggestions, `ImportRow` assembly, summary.
  - `ParseResult` gains `bank?: { dateFrom: string; dateTo: string }` (set by Task 7).

- [ ] **Step 1:** Run `npx jest --testPathPatterns="import"` — record it green before the refactor.
- [ ] **Step 2:** Move the code; `parseStatement` becomes: load account → profile → `readStatement` → `computeImportHashes` → `buildParseResult(userId, account, rows, hashes, profile.id, profile.categoryKeys)`.
- [ ] **Step 3:** Run the same suites — PASS with no test changes. Commit `refactor(import): share the parse result with other row sources`.

---

### Task 5: Keys and connections API

**Files:**
- Create: `backend/src/db/queries/bank.ts` (queries for Tasks 5–7; add each where first needed)
- Create: `backend/src/services/bank/connections.ts`
- Create: `backend/src/routes/bank.ts`
- Modify: `backend/src/index.ts` and `backend/src/test/testApp.ts` (mount `/api/bank` in both)
- Test: `backend/src/test/bankConnectionsApi.test.ts`

**Interfaces:**
- Consumes: Task 1 (`encryptSecret`, `decryptSecret`, `requireBankSync`, `isBankSyncEnabled`), Task 2 client.
- Produces:
  - `loadCredentials(userId: number): Promise<EbCredentials>` — 400 `Add your Enable Banking keys first` when none.
  - `getConnection(userId: number, id: number)` — 404 `Bank connection not found` unless it is the caller's.
  - `markExpired(connectionId: number): Promise<void>`
  - `connectionStatus(c): 'pending' | 'active' | 'expiring' | 'expired'` — `pending` without a session; `expired` when `expired` is set or `valid_until <= now`; `expiring` within 7 days.
  - DTO `BankConnectionDto { id, aspspName, country, status, validUntil: string | null, accounts: { uid, iban, name, currency }[] }`.

Endpoints (all behind `authMiddleware`; all but the first call `requireBankSync()`):

| Method & path | Body | Response `data` |
|---|---|---|
| `GET /api/bank/credentials` | — | `{ enabled, applicationId: string \| null, hasKey: boolean }` |
| `PUT /api/bank/credentials` | `{ applicationId: uuid, privateKey: string }` | same shape (one record per user; saving replaces it) |
| `DELETE /api/bank/credentials` | — | `{ success: true }` (connections stay but cannot be used) |
| `GET /api/bank/aspsps?country=EE` | — | `{ name, country, beta, maxConsentDays }[]` |
| `GET /api/bank/connections` | — | `BankConnectionDto[]` |
| `POST /api/bank/connections` | `{ aspspName, country, redirectUrl }` | `{ url }` — creates a pending connection with a new state |
| `POST /api/bank/connections/:id/reconnect` | `{ redirectUrl }` | `{ url }` — new state on the existing row |
| `POST /api/bank/connections/complete` | `{ state, code }` | `BankConnectionDto` |
| `DELETE /api/bank/connections/:id` | — | `{ success: true }` |

Behaviour:
- `redirectUrl` must be an `https:` URL whose path is `/bank-callback` (400 otherwise).
- Save validates the key with `crypto.createPrivateKey` → 400 `Private key is not a valid PEM`.
- Start / reconnect: `state = crypto.randomBytes(24).toString('hex')`, `auth_started_at = now()`; the consent length comes from the bank's entry in `getAspsps` (Global Constraints), so look it up by name.
- Complete: finds the row by `auth_state` **and** `user_id`, started under 30 min ago, else 400 `Unknown or expired connection request`; clears `auth_state`, stores `session_id`, `valid_until`, `expired = false`, replaces `bank_connection_accounts` with the session's accounts (`iban` from `account_id.iban`). On a reconnect the old session is deleted at Enable Banking afterwards, best effort (errors ignored). Links are untouched (they match by uid).
- Delete: `deleteSession` best effort, then delete the row (links cascade).

- [ ] **Step 1: Write the failing tests** (supertest, fetch mocked; register a user as in `importApi.test.ts`; RSA key generated in the test):
  - `reports disabled without BANK_CREDENTIALS_KEY`: GET credentials → `enabled: false`; PUT → 503.
  - `stores keys without ever returning them`: PUT → 200, `hasKey: true`; the JSON text of PUT and GET responses contains neither `BEGIN` nor a 40-char slice of the PEM; `bank_credentials.private_key_enc` starts with `v1.`.
  - `rejects a malformed PEM without echoing it`: PUT `privateKey: 'not a key SECRET123'` → 400 `Private key is not a valid PEM`, body does not contain `SECRET123`.
  - `starts a connection`: POST connections → `data.url` from the mocked `/auth`; the mocked `/auth` body has `state` equal to the stored `auth_state` and `access.valid_until` about 180 days ahead for a bank with `maximum_consent_validity: 15552000`.
  - `completes a connection once`: complete with that state → DTO `status 'active'`, two accounts; the same state again → 400 `Unknown or expired connection request`.
  - `refuses another user's state` → 400, same message, nothing stored.
  - `reconnect keeps links`: set a link row by SQL, reconnect + complete with the same uid → the link row is still there; the old session got a `DELETE /sessions/<old>`.
  - `delete removes the connection and its links`.
- [ ] **Step 2:** `npx jest --testPathPatterns=bankConnectionsApi` — FAIL.
- [ ] **Step 3:** Implement queries, service and routes (Zod schemas in the route file, as in `routes/import.ts`).
- [ ] **Step 4:** Run — PASS. Commit `feat(bank): keys and bank connections API`.

---

### Task 6: Linking app accounts to bank accounts

**Files:**
- Create: `backend/src/services/bank/links.ts`
- Modify: `backend/src/routes/bank.ts`, `backend/src/services/accounts.ts`, `backend/src/services/accountShares.ts`, `backend/src/types/index.ts`, `backend/src/db/queries/bank.ts`
- Test: `backend/src/test/bankLinks.test.ts`

**Interfaces:**
- Consumes: Task 5 (`getConnection`, `connectionStatus`).
- Produces:
  - `PUT /api/bank/links/:accountId` `{ connectionId, uid }` → `BankLinkDto`; `DELETE /api/bank/links/:accountId` → `{ success: true }`. Both: ADMIN on the account.
  - `BankLinkDto { connectionId, uid, aspspName, accountName: string | null, iban: string | null, currency: string, status: 'pending' | 'active' | 'expiring' | 'expired' | 'unmapped', validUntil: string | null, loadedTo: string | null, ownConnection: boolean }` — `unmapped` when the uid is not among the connection's accounts.
  - `getLinkDtos(accountIds: number[], userId: number): Promise<Map<number, BankLinkDto>>` — used by `getAccounts`.
  - `deleteLinksOfUser(tx: Tx, accountId: number, userId: number): Promise<void>` — deletes links on the account whose connection belongs to `userId`.
  - `Account.bank_link?: BankLinkDto | null` in `types/index.ts`; `getAccounts` fills it (null when none).

Rules: the account must be of type `bank` (400 `Only a bank account can be linked to a bank`); the connection must be the caller's (404 as in Task 5) and have the uid (400 `No such bank account in this connection`); a bank account currency other than `XXX` must equal the app account's (400 `The bank account is in <X> but the account is in <Y>`). Relinking replaces the link and resets `loaded_to` to null only when the uid or connection changes. `updateAccount` refuses changing a linked account's type (400 `Unlink the bank first`). `removeMember` calls `deleteLinksOfUser` inside both of its transactions for the departing user.

- [ ] **Step 1: Write the failing tests:**
  - `links with ADMIN, refuses WRITE`: a co-owner (level 3) links with their own connection → 200; a level-2 member → 403.
  - `refuses another user's connection` → 404.
  - `refuses a non-bank account` (a `cash` and a tracked `crypto` account) and `refuses a currency mismatch` (EUR bank account, USD app account) → 400 with the messages above; `XXX` bank account + USD app account → 200.
  - `lists the link on the account`: `GET /api/accounts` gives `bank_link.status 'active'`, `loadedTo null`, `ownConnection true`; for another member `ownConnection false`.
  - `marks a link unmapped after a reconnect drops its uid` (replace the connection's accounts by SQL) → `status 'unmapped'`.
  - `drops the link when its owner leaves the account`: member links with own connection, then `DELETE /api/accounts/:id/shares/<member>` by the owner → `bank_link` null; same for the member leaving.
  - `refuses changing a linked account's type` (bank → cash) → 400 `Unlink the bank first`.
- [ ] **Step 2:** `npx jest --testPathPatterns=bankLinks` — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the new suite plus `accounts|accountShares|sharing` — PASS. Commit `feat(bank): link accounts to bank accounts`.

---

### Task 7: Load from bank and the "loaded up to" marker

**Files:**
- Modify: `backend/src/services/bank/links.ts`, `backend/src/routes/import.ts`, `backend/src/services/import/index.ts`
- Test: `backend/src/test/bankLoad.test.ts`

**Interfaces:**
- Consumes: Task 2 (`fetchTransactions`, `BankAccessError`), Task 3 (`toParsedRows`, `computeBankHashes`), Task 4 (`loadWritableAccount`, `buildParseResult`), Task 5 (`loadCredentials`, `markExpired`).
- Produces:
  - `loadFromBank(userId: number, accountId: number, opts: { dateFrom?: string; psu: PsuContext }): Promise<ParseResult>` — result has `format: 'enablebanking'` and `bank: { dateFrom, dateTo }`.
  - `POST /api/import/bank` `{ accountId, dateFrom?: isoDate }` (calls `requireBankSync()`); route builds `psu` from the leftmost `X-Forwarded-For` entry (else `req.ip`) and `User-Agent`.
  - `reconcile(userId, accountId, rows, opts?: { bankLoadedTo?: string })`; reconcile schema gets `bankLoadedTo: isoDateSchema.optional()` and `rows` may be empty only when `bankLoadedTo` is given (Zod `refine`, 400 otherwise).
  - `advanceLoadedTo(accountId: number, date: string): Promise<void>` — `UPDATE … SET loaded_to = GREATEST(COALESCE(loaded_to, $2), $2)`; 400 `This account is not linked to a bank` when no link.

Load rules, in order: account writable and not tracked (`loadWritableAccount`); link exists (400 `This account is not linked to a bank`); link status `unmapped` → 409 `This bank account is no longer in the connection — link it again`; status `expired` or `pending` → 409 `Bank access expired — reconnect`; credentials of the **connection owner** (`loadCredentials(connection.user_id)`); window per Global Constraints (`dateFrom` from the body is used only when there is no marker; later than today → 400); `BankAccessError` → `markExpired` and the same 409. `bankLoadedTo` later than today → 400. The marker moves only after `createImportedTransactions` has returned.

- [ ] **Step 1: Write the failing tests** (fixtures from Task 2; a linked EUR account on an `XXX` bank account):
  - `returns the review rows`: POST `/api/import/bank` → 200, `format 'enablebanking'`, `bank.dateTo` = today, `bank.dateFrom` = today − 90; PDNG and USD rows absent; requested URL has those dates.
  - `honours the first-load date` → `date_from` in the URL = given date.
  - `confirm moves the marker; the next load starts two days earlier and shows duplicates`: reconcile the rows with `bankLoadedTo: dateTo` → `loaded_to = dateTo`; a second load requests `date_from = dateTo − 2` and returns every row as `duplicate`.
  - `cancel does not move the marker`: load twice without reconcile → both use the first-load window.
  - `an empty confirm moves the marker`: reconcile `rows: []`, `bankLoadedTo` → 200 `{created:0, skipped:0}`, marker moved; `rows: []` without `bankLoadedTo` → 400.
  - `a failed confirm does not move the marker`: a row with a `transferAccountId` the user cannot write → 403, `loaded_to` unchanged.
  - `the marker never goes backwards`: `bankLoadedTo` earlier than `loaded_to` → `loaded_to` unchanged.
  - `possible duplicates against hand-entered rows`: insert a hash-less expense with the date and amount of a fixture row → that row is `possible_duplicate`.
  - `expired consent`: `valid_until` in the past → 409 `Bank access expired — reconnect`, no fetch; a 401 from the mocked transactions endpoint → 409 and the connection now reports `expired`.
  - `WRITE can load, READ cannot`: level-2 member → 200 (with the owner's connection); level-1 → 403.
  - `unmapped link` → 409 with the message above.
- [ ] **Step 2:** `npx jest --testPathPatterns=bankLoad` — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the full backend suite `npm test` — PASS. Commit `feat(bank): load bank transactions into the import preview`.

---

### Task 8: Frontend — models, API and the Bank connections dialog

**Files:**
- Create: `frontend/src/app/models/bank.ts`
- Create: `frontend/src/app/features/bank/bank-dialog.service.ts`
- Create: `frontend/src/app/features/bank/bank-connections/bank-connections.{ts,html,scss,spec.ts}`
- Modify: `frontend/src/app/core/api.service.ts`, `frontend/src/app/models/account.ts`, `frontend/src/app/models/import.ts`, `frontend/src/app/features/header/header.{ts,html}`

**Interfaces:**
- Consumes: the endpoints of Tasks 5–7.
- Produces:
  - `models/bank.ts`: `BankCredentials`, `BankAspsp { name, country, beta, maxConsentDays }`, `BankConnection` (= `BankConnectionDto`), `BankLink` (= `BankLinkDto`), `BankStatus`; `BANK_COUNTRIES` (`EE`, `CY`, `ES`, `RO` first, then the other EEA codes); `bankRedirectUrl(): string` = `` `${location.origin}/bank-callback` ``.
  - `Account.bank_link?: BankLink | null`; `ImportParseResult.bank?: { dateFrom: string; dateTo: string }`.
  - `ApiService`: `getBankCredentials()`, `saveBankCredentials(body)`, `deleteBankCredentials()`, `getBankAspsps(country)`, `getBankConnections()`, `startBankConnection(aspspName, country)` and `reconnectBank(id)` (both send `redirectUrl: bankRedirectUrl()`), `completeBankConnection(state, code)`, `deleteBankConnection(id)`, `linkBankAccount(accountId, connectionId, uid)`, `unlinkBankAccount(accountId)`, `loadFromBank(accountId, dateFrom?)`; `reconcileImport(accountId, rows, bankLoadedTo?)` sends `bankLoadedTo` only when given.
  - `BankDialogService.openConnections(): Promise<void>`, `openLink(account: Account): Promise<void>` (Task 9 adds the component).

Dialog content (`size: 'm'`, label `Bank connections`; Taiga form style as in `account-form` / `profile-form`):
- `enabled: false` → one line `Bank sync is not configured on this server.` and nothing else.
- **Key:** Application ID and private key (textarea, or a `.pem` file read into it). Once a key is stored the textarea shows the placeholder `Key loaded — paste a new one to replace it`. A hint with `bankRedirectUrl()` shown read-only: `Register <url> as a redirect URL in your Enable Banking application, then activate the application with "Activate by linking accounts" in the Enable Banking control panel.` Buttons Save / Remove key.
- **Banks:** each connection: bank name, country, status chip (`Active until <date>`, `Expires in N days` for `expiring`, `Expired`, `Not completed`), its bank accounts (name or IBAN, currency), buttons Reconnect and Disconnect (confirm with `TUI_CONFIRM`).
- **Connect a bank:** country select → bank select (from `getBankAspsps`) → Connect, which does `location.assign(url)`.
- Header user dropdown: `Bank connections` (`@tui.landmark`) between Profile and Change password.

- [ ] **Step 1: Write the failing specs** in `bank-connections.spec.ts` (mock `ApiService` with `vi.fn` returning `of({ data, error: null })`, as other dialog specs do):
  - `shows only the not-configured line when disabled`.
  - `never pre-fills the private key and shows the loaded placeholder`.
  - `shows the callback address to register`.
  - `starts a connection with the callback address`: Connect calls `startBankConnection` and the request body has `redirectUrl` = `bankRedirectUrl()`.
  - `marks a connection expiring within 7 days` → text `Expires in 3 days`.
- [ ] **Step 2:** `cd frontend && npx ng test --watch=false --include=src/app/features/bank/bank-connections/bank-connections.spec.ts` — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run the spec and `npm test` — PASS; `npm run build` succeeds. Commit `feat(frontend): bank connections dialog`.

---

### Task 9: Frontend — callback route and link dialog

**Files:**
- Create: `frontend/src/app/features/bank/bank-callback/bank-callback.{ts,spec.ts}` (inline template)
- Create: `frontend/src/app/features/bank/bank-link/bank-link.{ts,html,spec.ts}`
- Modify: `frontend/src/app/app.routes.ts`, `frontend/src/app/features/bank/bank-dialog.service.ts`, `frontend/src/app/features/header/header.{ts,html}`

**Interfaces:**
- Consumes: Task 8 (`ApiService`, `BankDialogService`).
- Produces: route `bank-callback` (`authGuard`, lazy `BankCallback`); `BankLink` dialog with `data: Account`, completes with `true` when the link changed.

Behaviour:
- `BankCallback` reads `state`, `code`, `error` from the query. With state+code it calls `completeBankConnection`, then `router.navigate(['/dashboard'], { replaceUrl: true })` and `bankDialogs.openConnections()`, and shows `Bank connected`. With `error` or a failed complete it shows the error via `NotificationService` (`Unknown or expired connection request` as the backend words it), navigates to the dashboard and opens the connections dialog. While working: a `tui-loader`.
- Header account settings dropdown, for `account.type === 'bank'` and `canEditFiltered()`: `Bank link` (`@tui.link`) → `openLink`.
- `BankLink` dialog: a select of every bank account of the user's connections (`<bank> · <name or IBAN> · <currency>`), the current link pre-selected, Save / Unlink / Cancel. Accounts whose currency is neither `XXX` nor the app account's are shown disabled. On save `AccountsState.reload()`.

- [ ] **Step 1: Write the failing specs:**
  - `bank-callback`: with `?state=s&code=c` it calls `completeBankConnection('s','c')`, navigates to `/dashboard` and opens the connections dialog; with `?error=access_denied` it does not call complete and shows an error.
  - `bank-link`: currency-mismatched options disabled; Save calls `linkBankAccount(account.id, connectionId, uid)`; Unlink calls `unlinkBankAccount`.
- [ ] **Step 2:** Run both specs — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run — PASS. Commit `feat(frontend): bank callback route and account linking`.

---

### Task 10: Frontend — Load from bank

**Files:**
- Create: `frontend/src/app/features/bank/bank-load/bank-load.{ts,spec.ts}` (first-load date dialog, inline template)
- Modify: `frontend/src/app/features/import/import-dialog.service.{ts,spec.ts}`, `frontend/src/app/features/import/import-review/import-review.{ts,html}` and its spec, `frontend/src/app/features/header/header.{ts,html}`

**Interfaces:**
- Consumes: Task 8 (`loadFromBank`, `reconcileImport(…, bankLoadedTo)`, `Account.bank_link`).
- Produces: `ImportDialogService.openFromBank(account: Account): Promise<ImportReconcileResult | null>`.

Behaviour:
- Header settings dropdown, when `account.bank_link` and `canWriteFiltered()`: `Load from bank` (`@tui.cloud-download`); its label gets ` (expired)` / ` (relink)` for `expired` / `unmapped`, and stays enabled (the backend message explains).
- `openFromBank`: when `bank_link.loadedTo` is null, open `BankLoad` (one date field `Load from`, default today − 90 days, max today) and cancel there ends everything; otherwise no dialog. Then `loadFromBank`. Zero rows → `reconcileImport(account.id, [], bank.dateTo)` and `No new transactions in the bank`; otherwise `openReview(parsed)` as today. Success handling (reloads, toast) is shared with `open`.
- `import-review`: when `result.bank` is set, the submit sends `bankLoadedTo: result.bank.dateTo`, and `canSubmit` allows zero selected rows; the button then reads `Mark as loaded` instead of `Import`. A file import is unchanged.

- [ ] **Step 1: Write the failing specs:**
  - `import-dialog.service`: first load opens `BankLoad` and passes its date; later loads skip it; zero rows reconcile `[]` with `bankLoadedTo` and do not open review.
  - `import-review`: with `bank` set and nothing selected, the button is enabled, reads `Mark as loaded`, and `reconcileImport` gets `(id, [], '2026-10-27')`; without `bank` and nothing selected, it is disabled.
- [ ] **Step 2:** Run the specs — FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** `npm test` and `npm run build` — PASS. Commit `feat(frontend): load transactions from the bank`.

---

### Task 11: Docs and the manual check

**Files:**
- Modify: `CLAUDE.md`

- [ ] **Step 1:** In `CLAUDE.md`: replace "Direct bank sync via Enable Banking is designed but not built" with a one-line pointer; add a `#### Bank sync (Enable Banking)` section after "Bank-statement import" (tables of migration 018, endpoints, marker rule, hash namespace, who can link/load, link dropped with its owner's access); bump the migration range to 001→018; add `BANK_CREDENTIALS_KEY` and `ENABLE_BANKING_API_URL` to the env list. Commit `docs: document bank sync`.
- [ ] **Step 2 (prod, the user does it):** generate the key (`openssl rand -base64 32`), set `BANK_CREDENTIALS_KEY` in the Render dashboard for `swarmer-finance-api`, register `https://<static site>/bank-callback` as a redirect URL in the Enable Banking app.
- [ ] **Step 3 (manual on prod, with the user, after deploy):** in the dialog enter the application id and `backend/banks/<app-id>.pem`; connect `LHV Pank` (EE); link the EUR LHV account that holds the `(..7101)…` rows; Load from bank from 90 days ago. Expected: rows already in the DB are `possible_duplicate`, rows after 2026-10-11 are `new`. Confirm a few, load again: they are `duplicate`, the request starts at marker − 2 days.
- [ ] **Step 4:** update memory `bank_sync_deferred.md`.
