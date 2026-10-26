# Deploy to Render (backend + frontend), database on Neon

## Intent

Swarmer Finance has so far run only locally. The goal is to make it usable
from anywhere for the owner (user #1) and family (user #2, maybe one or two
more people later): the backend and frontend on Render, the database on
Neon. The owner's real data moves from the local DB to production once;
local Postgres stays for development.

Success: both of them open the Render URL, log in with their current
passwords and see the same accounts, balances and transactions they have
locally today; a push to `main` redeploys both services.

## Goals

- The frontend is a Render **static site**, the backend a Render **web
  service** on the **free** tier, both described in `render.yaml` at the repo
  root (Blueprint) and auto-deployed from GitHub
  `dmitry-ulitin/swarmer-finance`, branch `main`.
- The DB is the Neon project "Swarmer Finance" (`red-lab-45916696`,
  aws-eu-central-1, PG 18, database `neondb`, branch `production`). It is
  empty today.
- Two backend hardening changes (the owner's decision):
  1. **Registration switch**: an environment variable turns
     `POST /api/auth/register` off. The family registers, then it is turned off.
  2. **Login rate limiting**: repeated failed attempts against
     `POST /api/auth/login` are throttled.
- A one-time migration of users #1 and #2 and everything that belongs to them
  from the local `finance_db_nu` to Neon.

## Non-goals

- Paid Render plans (the owner will switch later if the free tier's sleep
  becomes annoying), custom domain, CI running tests before deploy,
  monitoring/alerting, staging environment, Neon branches per PR.
- Keeping prod and local in sync after the migration: they diverge from then on.
- Frontend changes beyond what deploy strictly needs (no UI for "registration
  closed", no hiding of the register link; the existing error display is
  enough).

## Anti-goals

- Losing or altering real data: the migration must not touch the local
  `finance_db_nu`, and prod must match it for users #1/#2.
- Secrets committed to the repo (`render.yaml` declares variables with
  `sync: false`; values are entered in the Render dashboard).
- Reusing the dev JWT secrets in production.
- Moving the test user #3 (`test@gmail.com`) to production.

## Current state (facts)

- Backend: `npm run build` = `tsc` → `dist/`, `npm start` = `node dist/index.js`,
  `GET /api/health` exists. `src/index.ts` reads `PORT`, `CORS_ORIGIN`
  (default `*`). Migrations are `.sql` files in `src/db/migrations/`, run
  by `npm run migrate` = `tsx src/db/migrate.ts`, which uses `DATABASE_URL`
  and records files in `schema_migrations`. `tsc` does not copy the `.sql`
  files to `dist/`, so migrations run from `src` via `tsx`
  (a devDependency).
- Frontend: Angular, `@angular/build:application`; all API calls use
  relative `/api/...` URLs (dev proxy `frontend/proxy.conf.json` →
  `localhost:3000`).
- Auth: `routes/auth.ts` / `services/auth.ts`; errors are thrown as
  `{ statusCode, message }` and returned in the `{ data, error }` envelope.
  Password minimum is 6 chars; no rate limiting today.
- `backend/.env` holds `NEON_DATABASE_URL` (pooler) and
  `NEON_DATABASE_URL_UNPOOLED` (direct) for the new project; the app reads
  only `DATABASE_URL`, which points at local `finance_db_nu`.
- Local DB (container `swarmer-finance-postgres-1`, PG 15): users 1, 2, 3.
  User 3 owns 1 account, 3 transactions, 9 categories and is not linked to
  users 1/2 (no shares, no shared transactions, none of its categories used
  by others). Tables: `users, accounts, account_shares, categories,
  transactions, chain_seen_txids, exchange_rates, schema_migrations`.
  System categories (ids 1–5, `user_id` NULL) are seeded by migrations.
- Backup method: `docker exec swarmer-finance-postgres-1 pg_dump -U finance_user
  -Fc finance_db_nu > ~/backups/finance_db_nu-<timestamp>.dump` (the host
  `pg_dump` is v13 and refuses the v15 server).

## Decided

### Topology

- Same origin for the browser: the static site has a **rewrite** rule
  `/api/*` → `https://<backend>.onrender.com/api/*`, then an SPA rewrite
  `/*` → `/index.html`. No frontend code change, no CORS needed
  (`CORS_ORIGIN` set to the static site's URL anyway).
- Both services in region **Frankfurt** (next to Neon eu-central-1).

### Backend service

- The app connects through the Neon **pooled** URL (`DATABASE_URL`);
  migrations use the **direct** URL (`DATABASE_URL_UNPOOLED`).
- Environment on Render: `DATABASE_URL`, `DATABASE_URL_UNPOOLED`, new random
  `JWT_SECRET` and `JWT_REFRESH_SECRET` (≥32 chars, different from dev),
  `CORS_ORIGIN`, the registration switch, and the optional API keys the
  owner has locally (`COINGECKO_API_KEY`, `ETHERSCAN_API_KEY`, optionally
  `TRONGRID_API_KEY`). URLs with working defaults are not set.
- Node version pinned to the local major (26) so Render doesn't build with a
  different one.

### Registration switch

- One env variable (name is the builder's call, e.g. `REGISTRATION_ENABLED`).
  When registration is off, `POST /api/auth/register` answers 403 with an
  error message saying registration is closed, before any DB work.
- Default when unset: **on**. Local dev and tests stay unchanged, and the
  family can register right after the first deploy; the owner switches it
  off in the dashboard afterwards. (Users 1 and 2 arrive with the
  migration, so registration matters only for future family members.)
- Covered by a backend test.

### Login rate limiting

- Applies to `POST /api/auth/login` (and `register` while it is open).
  Failed logins are counted per **client IP + email** (my call). Express
  trusts Render's proxy (`app.set('trust proxy', ...)`) so the IP comes from
  `X-Forwarded-For`. Requests pass through the static-site rewrite *and*
  Render's load balancer, so the right hop count is checked on deploy (log
  `req.ip` once). If the real client IP can't be recovered without trusting
  spoofable hops, keep the trust setting conservative; the key then
  degrades to effectively per-email, which still stops password guessing
  and can at worst briefly lock one family account.
- In-memory state is acceptable: one instance; a restart or sleep resets
  the counters.
- A throttled request gets 429 in the standard `{ data: null, error }`
  envelope.
- Must not break the existing auth tests (they log in many times):
  limits are disabled or raised in tests.
- Covered by a backend test.

### Data migration (one-time)

1. Fresh local backup by the method above.
2. Run migrations against Neon (direct URL) so the schema comes from the
   migration files, not from a dump.
3. Copy rows of users 1 and 2 and everything that belongs to them: their
   `users` rows (with password hashes, so current passwords keep working),
   their accounts, `account_shares` among them, their categories,
   transactions on their accounts, `chain_seen_txids` of their accounts, and
   all of `exchange_rates`. **IDs are preserved**, and afterwards every
   `SERIAL`/identity sequence is set past the max id. System categories
   1–5 already exist from the migrations and are not copied.
4. Verify: per-table row counts for users 1/2 equal between local and Neon,
   and account balances (start_balance + sum of movements) match per
   account.
5. Local `finance_db_nu` is only read, never modified.

Claude runs the backup, the migrations and the copy in the session from
the owner's machine (`backend/.env` has the Neon URLs). The owner approves
each command, and Claude checks the results live (the owner's decision). Tooling
(data-only dump of a filtered copy, `COPY` via psql, or a small script) is
the builder's call. If a dump is used, it must come from the container's
`pg_dump` (v15); restoring a v15 dump into PG 18 is fine.

The copy script refuses to run unless Neon holds nothing beyond what the
migrations seed (no users, no accounts, no transactions), so it can't
collide with ids handed out by a live app. (My call.)

### Rollout order

The data goes in **before** the app is reachable, so nobody can create
rows (and ids) in Neon in between. (My call, reordering the earlier idea.)

1. Code changes (switch + rate limit + `render.yaml` + Node pin), tests green,
   pushed to `main`.
2. Data migration to Neon from the owner's machine: migrations via the
   direct URL, then the copy, then the checks.
3. Owner creates the Blueprint in the Render dashboard from the repo and
   fills the `sync: false` secrets (dashboard steps written out for them).
   The start command's migrate is then a no-op.
4. Smoke test on the Render URL: health, login as user 1, accounts/balances
   match local, a page refresh on a deep link works (SPA rewrite), one
   statement-import parse works (exercises the 10 MB JSON body through the
   rewrite).
5. Owner turns registration off once any additional family member has
   registered (or right away).

## Left to the builder

- Exact `render.yaml` contents, service names, build commands (e.g.
  `npm ci` vs `npm install`, ensuring devDependencies are installed for
  `tsc`/`tsx`), the Angular build output path to publish.
- **How migrations run on deploy.** Render's pre-deploy command is
  not available on the free tier. My call: the backend start command runs
  `migrate` against `DATABASE_URL_UNPOOLED`, then starts the server
  (a no-op migrate costs a moment on each cold start). Changing this, e.g. to
  running migrations manually from the owner's machine, is fine if it's
  documented.
- Rate-limit library vs a few lines of own code, and the exact limits
  (something like 10 failed attempts per 15 minutes per IP is reasonable).
- Whether `pg`'s SSL warning is silenced via `sslmode=verify-full` in the
  Neon URLs.
- **Risk to verify on deploy:** a request through the static-site rewrite
  while the free backend is asleep must wait out the cold start (~30–60 s)
  rather than fail. If the rewrite times out, fall back to calling the
  backend URL directly. That needs a configurable API base URL in the
  frontend and `CORS_ORIGIN` set to the static site URL. Report this to the
  owner before switching.
- Updating `CLAUDE.md` (environment variables, deployment section) and
  `.env.example` for the new variables.
