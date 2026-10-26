# Render Deploy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Run Swarmer Finance on Render (static frontend + free web service
backend) against the Neon DB, with users 1 and 2 copied from the local DB,
registration that can be switched off and throttled logins.

**Architecture:** Two small auth changes in the backend, a `render.yaml`
Blueprint (the static site proxies `/api/*` to the backend through a rewrite),
a one-off copy script `backend/scripts/copy-to-neon.ts`. The copy is rehearsed
into a scratch local DB, then run against Neon before the Render services
exist.

**Tech Stack:** Express 5, `pg`, Jest + supertest, Angular build, Render
Blueprint, Neon Postgres 18 (local Postgres 15 in Docker).

**Spec:** `docs/superpowers/specs/2026-10-26-render-deploy-design.md`

## Global Constraints

- Render: free plan for the backend, region `frankfurt`, auto-deploy from `main` of `dmitry-ulitin/swarmer-finance`.
- Neon project `red-lab-45916696`, eu-central-1. The app uses the pooled URL (`DATABASE_URL`); migrations use the direct URL (`DATABASE_URL_UNPOOLED`).
- No secrets in the repo: secrets in `render.yaml` are `sync: false` or `generateValue: true`.
- Prod JWT secrets differ from dev.
- Only users 1 and 2 move. User 3 (`test@gmail.com`) does not. IDs are preserved and sequences are moved past the max id.
- Local `finance_db_nu` is only read. Take a backup first with the container's `pg_dump` (the host one is v13).
- Node pinned to major 26.
- Every command that touches Neon, Docker data or GitHub (push) is shown to the owner, who approves it.

## Review Focus

1. Email case: `Bob@x` and `bob@x` must hit the same limiter bucket. The schema lowercases the email before the route sees it. Pinned in Task 2.
2. A family member who mistypes a few times and then logs in must not stay throttled: a success clears the bucket. Pinned in Task 2.
3. `REGISTRATION_ENABLED` set to anything other than `false` (unset, `true`, empty) leaves registration on. Pinned in Task 1.
4. Running the copy twice, or into a Neon DB someone has already used, must refuse and write nothing. Pinned in Task 4, in the rehearsal's second run.
5. These go through the static-site rewrite: a deep-link refresh, a 10 MB statement upload, and a request while the backend sleeps. Checked live in Task 6.

---

### Task 1: Registration switch

**Files:**
- Modify: `backend/src/services/auth.ts` (`register`)
- Test: `backend/src/test/auth.test.ts`

**Interfaces:**
- Produces: env `REGISTRATION_ENABLED`. Registration is off only when the value is exactly `false`. When off, `register` throws `{ statusCode: 403, message: 'Registration is closed' }` before any query.

- [ ] **Step 1: Write the failing tests** in a new `describe('registration switch')` block in `auth.test.ts`. Save `process.env.REGISTRATION_ENABLED` before each test and restore it after.
  - `refuses registration when REGISTRATION_ENABLED=false`: status 403, `body.error === 'Registration is closed'`, `body.data === null`, and the email does not exist afterwards (a login with it returns 401).
  - `keeps registration open when REGISTRATION_ENABLED is unset or "true"`: both cases return 200.
  - `still allows login when registration is closed`: an existing user logs in, status 200.
- [ ] **Step 2: Run** `cd backend && npx jest --testPathPatterns=auth`. Expected: the 403 test fails (it gets 200).
- [ ] **Step 3: Implement.** Add the check as the first statement of `register` in `services/auth.ts`.
- [ ] **Step 4: Run** `npx jest --testPathPatterns=auth`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(auth): REGISTRATION_ENABLED=false closes registration`

### Task 2: Login throttling

**Files:**
- Create: `backend/src/services/loginLimiter.ts`
- Modify: `backend/src/routes/auth.ts` (login handler), `backend/src/index.ts`
- Test: `backend/src/test/loginLimiter.test.ts`

**Interfaces:**
- Produces in `services/loginLimiter.ts`:
  - `MAX_FAILURES = 10`, `WINDOW_MS = 15 * 60 * 1000`
  - `isBlocked(key: string, now?: number): boolean`
  - `recordFailure(key: string, now?: number): void`
  - `clearFailures(key: string): void`
  - `resetLoginLimiter(): void`, used by tests
  - State: an in-memory `Map<string, { count: number; firstAt: number }>`. A fixed window starts at the first failure. An expired entry counts as absent and is deleted when touched. When the map exceeds 10 000 entries, expired entries are swept.
- Login route: the key is `` `${req.ip}|${email}` ``.
  - A blocked key short-circuits to `next({ statusCode: 429, message: 'Too many failed login attempts, try again later' })` without calling `authService.login`. The response is the normal `{ data: null, error }` envelope.
  - A 401 from `login` calls `recordFailure` and logs `` console.warn(`Failed login for ${email} from ${req.ip}`) ``. That log line is how Task 6 checks the client IP.
  - A success calls `clearFailures`.

- [ ] **Step 1: Write failing tests** in `loginLimiter.test.ts`. Call `resetLoginLimiter()` in `beforeEach`, register a fresh user per test, and use `createTestApp()`.
  - `blocks the 11th attempt after 10 failures, even with the right password`: 10 wrong-password logins return 401, then the correct password returns 429 with `error === 'Too many failed login attempts, try again later'`.
  - `counts the email case-insensitively`: 10 failures alternate `Upper@...` and `upper@...`. Then the 11th attempt in either case returns 429.
  - `does not block another email from the same address`: after 10 failures for A, a correct login for B returns 200.
  - `a successful login clears the count`: 9 failures, 1 success, 9 failures, then the correct password returns 200.
  - `the window expires` (unit test on the service): `recordFailure(k, 0)` 10 times. Then `isBlocked(k, 1)` is true and `isBlocked(k, WINDOW_MS + 1)` is false.
- [ ] **Step 2: Run** `npx jest --testPathPatterns=loginLimiter`. Expected: FAIL, because the module is not found.
- [ ] **Step 3: Implement** `loginLimiter.ts` and wire it into the login handler.
- [ ] **Step 4: Trust Render's proxy.** In `index.ts`, add `app.set('trust proxy', 1)` after `const app = express()`. Leave `testApp.ts` without it, so supertest's IP stays `::ffff:127.0.0.1`. Task 6 confirms the hop count live.
- [ ] **Step 5: Run** the whole suite: `cd backend && npm test`. Expected: all suites pass. The existing auth tests use unique emails, so they never hit the limit.
- [ ] **Step 6: Commit** `feat(auth): throttle failed logins per IP and email`

### Task 3: Render Blueprint and docs

**Files:**
- Create: `render.yaml` (repo root)
- Modify: `backend/package.json`, `frontend/package.json` (add `"engines": { "node": "26.x" }`), `.env.example`, `CLAUDE.md`

- [ ] **Step 1: Write `render.yaml`** with these values:
  - **Backend.** Web service `swarmer-finance-api`:
    - `runtime: node`, `plan: free`, `region: frankfurt`, `rootDir: backend`, `branch: main`, `autoDeploy: true`
    - `buildCommand: npm ci --include=dev && npm run build`
    - `startCommand: DATABASE_URL=$DATABASE_URL_UNPOOLED npm run migrate && npm start`
    - `healthCheckPath: /api/health`
    - `envVars`:
      - `sync: false`: `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, `CORS_ORIGIN`, `COINGECKO_API_KEY`, `ETHERSCAN_API_KEY`, `TRONGRID_API_KEY`
      - `generateValue: true`: `JWT_SECRET`, `JWT_REFRESH_SECRET`
      - `REGISTRATION_ENABLED: "true"`
  - **Frontend.** Static site `swarmer-finance`:
    - `runtime: static`, `rootDir: frontend`, `buildCommand: npm ci && npm run build`, `staticPublishPath: dist/swarmer-finance/browser`
    - `routes`, in this order:
      1. rewrite `/api/*` → `https://swarmer-finance-api.onrender.com/api/*`
      2. rewrite `/*` → `/index.html`
- [ ] **Step 2: Verify the builds locally.**
  - `cd frontend && npm run build`. Expected: success, with `frontend/dist/swarmer-finance/browser/index.html` present.
  - `cd backend && npm run build`. Expected: success.
- [ ] **Step 3: Update docs.**
  - `.env.example`: add `REGISTRATION_ENABLED` and `DATABASE_URL_UNPOOLED`, each with a one-line comment.
  - `CLAUDE.md`:
    - in the intro, replace the "Local-only deployment" line with a "Deployment" subsection: Render Blueprint `render.yaml`, Neon `red-lab-45916696`, migrations run on start through the unpooled URL, how registration is closed;
    - list the new env vars under Environment Variables;
    - mention login throttling under Authentication.
- [ ] **Step 4: Commit** `feat(deploy): Render blueprint for the API and the static frontend`. Ask the owner before `git push origin main`. The push deploys nothing until the Blueprint exists.

### Task 4: Copy script, rehearsed locally

**Files:**
- Create: `backend/scripts/copy-to-neon.ts`
- Modify: `backend/scripts/README.md` (one paragraph: what it is, how to run it)

**Interfaces:**
- Run as `cd backend && npx tsx scripts/copy-to-neon.ts <TARGET>`.
  - `<TARGET>` is a postgres URL, or the name of an env var in `backend/.env` that holds one.
  - The source is `DATABASE_URL` from `backend/.env`.
  - The script refuses to run if source and target resolve to the same host and database.
- `USER_IDS = [1, 2]`.

Behavior, in order:
1. **Source snapshot.** Open the source with `BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY`.
2. **Preconditions on the target.** Abort with a message, and write nothing, unless all of these hold:
   - `schema_migrations` filenames equal the source's;
   - `users`, `accounts`, `transactions`, `account_shares`, `chain_seen_txids` and `exchange_rates` are empty;
   - `categories` holds only `user_id IS NULL` rows.
3. **Select from the source:**
   - `users`: `id = ANY($1)`
   - `accounts`: `user_id = ANY($1)`
   - `account_shares`: `account_id` in those accounts
   - `categories`: `user_id = ANY($1)`
   - `transactions`: `debit_account_id` or `credit_account_id` in those accounts
   - `chain_seen_txids`: `account_id` in those accounts
   - `exchange_rates`: all rows
4. **Insert into the target** in one transaction, in that table order. Use one statement per table: `INSERT INTO t SELECT * FROM json_populate_recordset(NULL::t, $1::json)` with the rows as JSON. A single statement lets a category reference a parent in the same batch, because non-deferred FKs are checked at the end of the statement. Then, for `users`, `accounts`, `categories`, `transactions` and `exchange_rates`, run `SELECT setval(pg_get_serial_sequence('<t>','id'), (SELECT max(id) FROM <t>))`. Commit.
5. **Verify** and print a table of source vs target:
   - per-table row counts (source counts use the filters from step 3);
   - per account, `start_balance + Σcredit(as credit_account) − Σdebit(as debit_account)`.

   Exit code 1 on any mismatch.

- [ ] **Step 1: Back up the local DB:** `docker exec swarmer-finance-postgres-1 pg_dump -U finance_user -Fc finance_db_nu > ~/backups/finance_db_nu-$(date +%Y%m%d-%H%M%S).dump`. Expected: a non-empty file.
- [ ] **Step 2: Write the script.**
- [ ] **Step 3: Create the rehearsal target.**
  - `docker exec swarmer-finance-postgres-1 createdb -U finance_user finance_copy_test`
  - `cd backend && DATABASE_URL=postgresql://finance_user:<pw>@localhost:5432/finance_copy_test npm run migrate`
  - Take the password from `TEST_DATABASE_URL`, and don't print it.
- [ ] **Step 4: Rehearse:** `npx tsx scripts/copy-to-neon.ts postgresql://…/finance_copy_test`. Expected: every count and balance row matches, exit code 0. Spot-check that `select count(*) from users` is 2 and `select nextval('transactions_id_seq')` returns a value above the copied max.
- [ ] **Step 5: Re-run the same command.** Expected: it aborts on the precondition, writes nothing and exits non-zero.
- [ ] **Step 6: Clean up.** `docker exec swarmer-finance-postgres-1 dropdb -U finance_user finance_copy_test`.
- [ ] **Step 7: Commit** `chore(scripts): one-off copy of users 1 and 2 to Neon`

### Task 5: Migrate and copy into Neon

Each command is shown to the owner first.

- [ ] **Step 1: Run the migrations on Neon:**
  ```bash
  cd backend && DATABASE_URL="$(grep '^NEON_DATABASE_URL_UNPOOLED=' .env | cut -d= -f2- | tr -d '"')" npm run migrate
  ```
  Expected: all 17 migrations complete.
- [ ] **Step 2: Copy:** `npx tsx scripts/copy-to-neon.ts NEON_DATABASE_URL_UNPOOLED`. Expected: everything matches, exit code 0.
- [ ] **Step 3: Cross-check with Neon MCP** `run_sql` on project `red-lab-45916696`: `select id, email from users` returns 1 and 2 only, and the transaction count equals the script's output.

### Task 6: Render setup and smoke test

- [ ] **Step 1: Give the owner the dashboard steps.**
  1. Render → New → Blueprint → connect `dmitry-ulitin/swarmer-finance` → apply `render.yaml`.
  2. Fill the secrets:
     - `DATABASE_URL` = Neon pooled URL, `DATABASE_URL_UNPOOLED` = direct URL;
     - `CORS_ORIGIN` = the static site's URL (`https://swarmer-finance.onrender.com`, or whatever Render assigns);
     - the API keys they use locally.
  3. If Render gave the API another hostname (for example with a suffix), fix the rewrite destination in `render.yaml` and push.
  4. If the build fails on Node 26, switch `engines` to the newest major Render offers and tell the owner.
- [ ] **Step 2: Smoke test** against the static site URL:
  - `curl -s https://<site>/api/health` returns `{"status":"ok"...}`. This goes through the rewrite.
  - Log in as user 1 in the browser. Account balances equal the local app.
  - Refresh on a deep link such as `/transactions`. The page loads.
  - Statement import parse with a real XLSX from `backend/banks/` succeeds.
- [ ] **Step 3: Check the client IP.**
  - Make one wrong-password login.
  - In the Render logs, the `Failed login ... from <ip>` line should show the owner's public IP (compare with `curl -s ifconfig.me`).
  - If it shows a Render-internal address, try `trust proxy` 2 and redeploy. If that IP can be spoofed with a forged `X-Forwarded-For`, keep 1 and tell the owner the limit is effectively per email.
- [ ] **Step 4: Check the cold start.**
  - Leave the backend idle for over 15 minutes, then time `curl -s -w '%{http_code} %{time_total}\n' https://<site>/api/health`.
  - Expected: 200 after the wake-up.
  - If the rewrite times out instead, stop and report to the owner (the spec's fallback is a direct API URL with CORS). Don't switch over without their approval.
- [ ] **Step 5: Close registration.** Once any additional family member has registered, the owner sets `REGISTRATION_ENABLED=false` in the dashboard. Check that registering then returns 403.
- [ ] **Step 6: Update memory** `neon_after_deploy.md`: prod is live, record the URLs, note that prod and local diverge from now on.
