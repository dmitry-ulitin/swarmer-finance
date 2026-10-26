# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A personal finance management web app: multi-user, with per-account sharing
(read / write / admin) between users. Core scope for now: income/expense
transactions with hierarchical categories, multi-currency accounts, manual
entry, bank-statement import (CSV/XLS/XLSX) and blockchain wallet sync.
Direct bank sync via Enable Banking is designed but not built
(`docs/superpowers/specs/2026-10-23-bank-sync-enable-banking-design.md`).
Investments/assets and analytics/reports beyond the category summary are
deferred to later phases.

Production runs on Render (`render.yaml` Blueprint, auto-deploy from
`main`) against Neon Postgres (project `red-lab-45916696`, eu-central-1):
`swarmer-finance-api` is a free web service that migrates through Neon's
unpooled URL on every start; `swarmer-finance` is a static site that rewrites
`/api/*` to the API, so the browser sees one origin. Secrets are set in the
Render dashboard. Prod data diverges from local dev from the one-off copy
(`backend/scripts/copy-to-neon.ts`) on.

Design specs and implementation plans for past features live in
`docs/superpowers/specs/` and `docs/superpowers/plans/`.

## Commands

### Backend (`/backend`)
```bash
npm run dev          # Dev server (tsx, no watch — restart after changes)
npm run build        # TypeScript compile to dist/
npm start            # Run production build
npm run migrate      # Run pending database migrations
npm test             # Jest tests
npm run test:watch   # Jest watch mode
npm run test:coverage # Coverage report
```

### Frontend (`/frontend`)
```bash
npm start            # Angular dev server on port 4200
npm run build        # Production build
npm test             # Vitest unit tests
```

### Local Dev (Docker)
```bash
docker-compose up -d        # Start local PostgreSQL
```

## Architecture

### Monorepo Structure
- `backend/` — Node.js + Express + PostgreSQL (raw SQL, no ORM)
- `frontend/` — Angular 22 standalone components + Taiga UI v5
- `docker-compose.yml` — local Postgres 15 (db: finance_db, localhost:5432)
- `backend/scripts/` — one-off SQL for migrating the legacy swarmerdb data

### Backend Request Flow
```
HTTP Request → Express Middleware (CORS, JSON) → Route Handler
→ Zod Validation Middleware → Auth Middleware (JWT verify)
→ Service Layer (business logic) → DB Queries (raw SQL) → PostgreSQL
→ Response: { data: T | null, error: string | null }
```

All API responses use this envelope format consistently.

### Authentication
- JWT access token (15min) + refresh token (7d), stored in `localStorage`
- Backend: `src/middleware/auth.ts` verifies JWT; `src/services/auth.ts` handles tokens/bcrypt
- Frontend: `AuthService` uses Angular Signals; `AuthInterceptor` injects Bearer token; `authGuard`/`publicGuard` protect routes
- `RefreshCoordinator` (`core/refresh-coordinator.ts`) makes the token refresh
  single-flight, so parallel 401s share one `/api/auth/refresh` call
- Failed logins are throttled in memory per client IP + email
  (`services/loginLimiter.ts`: 10 per 15 min, then 429; a success clears
  it); `index.ts` trusts one proxy hop for `req.ip`
- `REGISTRATION_ENABLED=false` closes `POST /api/auth/register` (403);
  any other value or unset leaves it open

### Frontend State Management
- **AuthService** (`core/auth.service.ts`): Signal-based `accessToken`, `userSignal`, computed `isAuthenticated`
- **CategoriesState** (`core/categories.state.ts`): Angular `resource()` API for async loading + computed hierarchical structure
- **AccountsState** (`core/accounts.state.ts`): Same pattern as CategoriesState — flat list of user accounts
- **TransactionsState** (`core/transactions.state.ts`): filters and the paged transaction list (20 per page)
- **ApiService** (`core/api.service.ts`): Thin HttpClient wrapper

### Database
- Migrations in `backend/src/db/migrations/` — run in order (001→017)
- Raw SQL queries in `backend/src/db/queries/`
- System root categories (Income id=1, Expenses id=2) seeded in migration 002; `user_id` is NULL for system categories
- Categories support parent/child hierarchy via `parent_id`; `root_id` tracks the Income/Expenses root
- Deleting a category moves its transactions to its parent (or the root's
  Uncategorized when the parent is a system category) and its children under
  the parent; it is refused (409) when a child's name is already taken
  there. `GET /api/categories/:id/delete-preview` reports this up front.
- Accounts table added in migration 003 (`name`, `currency`, `start_balance`); `start_balance` stored as an **INTEGER** at the account's `scale` (see
  below; e.g. 1000 = $10.00). The API takes and returns decimals; services
  convert with `toCents` / `toDecimal` (`services/currency.ts`)
- Migration 008 adds `type` (`cash` / `bank` / `crypto`) and per-type
  `settings` JSONB to accounts
- Once an account has transactions its `start_balance` cannot change (400;
  a correcting transaction fixes a mismatch instead). Account responses
  carry `last_transaction_date` (null when none), which the form uses to
  lock the field.
- An account's `scale` (decimal places of its stored integers) is set by the
  backend from the currency (`services/currencyScale.ts`: ISO minor units,
  BTC/ETH 8, USDT/USDC/TRX 6, SOL/TON 9); the API does not accept it, and a
  currency change that would rescale existing transactions is refused.
- Transactions created in migration 004: `debit`/`credit` stored as **INTEGERs** at the account's scale; `debit_account_id` and `credit_account_id` (both nullable); `category_id` (nullable)
- `account_shares` added in migration 009: `(account_id, user_id, level)`,
  level 1 = read, 2 = transactions, 3 = admin. The owner is **not** stored
  there — `accounts.user_id` is the only source of ownership, and
  `services/access.ts` synthesises level 4 (owner) for owned accounts.
  Granting someone level 3 makes the account co-owned: it then resolves to
  level 3 for its owner too, so level 4 means "personal account".
- `/api/accounts/:id/shares` manages members (`services/accountShares.ts`):
  GET needs level 1, POST/PUT/DELETE level 3, except DELETE on yourself
  (leave) at any level. Removing the owner or setting them below 3 moves
  ownership — to the co-owner acting, or, when the owner acts on themselves,
  to the earliest-granted other co-owner; with none (personal account) it is
  refused with "Delete the account instead". When a member loses access their
  expense/income rows on that account are re-assigned to the owner with the
  categories copied into the owner's tree, so `transactions.user_id` means
  "who entered it, or the owner who inherited it". Rows others entered there
  with the departing member's categories keep their author and get the
  category copied into that author's tree.
- Clean-up for mistaken/test accounts (ADMIN on the account, WRITE on every
  transfer peer): `DELETE /api/accounts/:id/transactions` removes all its
  transactions, `DELETE /api/accounts/:id?withTransactions=true` also removes
  the account. Transfers are never deleted but left to the other account as
  Uncategorized income/expense (`services/accounts.ts` `purgeAccount`).
- System category **Network fees** (id 5, under Expenses) seeded in
  migration 012; ids 1–5 are protected from edit/delete.

#### Blockchain-synced (tracked) accounts

A `crypto` account with `settings.address` and a supported
`settings.blockchain` (today `bitcoin`, `tron` and `ethereum`, see
`services/chain/index.ts`) is *tracked*: `POST /api/accounts/:id/sync` loads
its history through a chain provider (`services/chain/bitcoin.ts`, Esplora
at `BITCOIN_ESPLORA_URL`; `services/chain/tron.ts`, TronGrid at
`TRON_API_URL`; `services/chain/ethereum.ts`, Etherscan v2 when
`ETHERSCAN_API_KEY` is set, else Blockscout at `ETHEREUM_API_URL`) and
`services/chainSync.ts` writes it, identified by `import_hash` (`txid`,
`txid:out`, `txid:fee`); `chain_seen_txids` (migration 013) records which
txids each account's own sync has processed, which is what paging stops on. Tracked accounts start at 0 in one of the chain's currencies (TRON: `TRX` or `USDT`, Ethereum: `ETH` or `USDT`, each synced
separately; fees always land on the TRX / ETH account; Ethereum addresses
are stored lowercase and ETH amounts are rounded from wei to 1e-8);
their transactions cannot be created, deleted or imported by hand, and an
edit may change only the category, the other (untracked) account and its
amount when currencies differ, and the description. A payment between two
tracked wallets is one transfer, merged whichever side syncs first. A wallet
is address + chain + currency: only accounts matching all three merge as
transfers, and a synced account's currency cannot change.

An account that already has transactions can be made tracked (requires WRITE
on every transfer peer, checked up front): switching tracking on, or
pointing an already-tracked, never-synced account at a different wallet,
clears its `chain_seen_txids` and zeroes `start_balance`, and the first sync
(`services/chainAdopt.ts`) adopts rows that match an on-chain transaction —
by a txid in `description`, else by exact amount and date ±3 days — keeping
their category and description, and removes the rest (transfers are left to
the other account).

#### Bank-statement import

`POST /api/import/parse` (WRITE on the account, not for tracked accounts)
reads a base64 CSV or XLS/XLSX statement (`services/import/csv.ts`,
`workbook.ts`), detects the bank from its header row
(`services/import/profiles.ts`: LHV, Bank of Cyprus, Alfa-Bank, CaixaBank,
UniCredit — a new bank is a new profile, i.e. data, not code) and returns
rows marked `new` / `duplicate` / `possible_duplicate`. A row's
`import_hash` (`services/import/hash.ts`, migration 011) is the bank's
reference when it has one, else row content plus an occurrence index;
`possible_duplicate` is an advisory date-and-amount match. Rows come with
category suggestions learned from the user's history
(`services/import/categorize.ts`). `POST /api/import/reconcile` inserts the
rows the user kept — as expense/income, or as transfers when a
`transferAccountId` is given (the peer amount converted at the current
rate) — re-checking access and hashes but not the
advisory match. Real statements go in `backend/banks/` (gitignored);
redacted test copies in `backend/src/test/fixtures/banks/`.

#### Exchange rates

`services/currency.ts` fetches rates from Frankfurter (ECB) and falls back to
CoinGecko for pairs it does not cover (crypto, RUB, …), caching them in
`exchange_rates` (migrations 005, 010, 016). Account balances and the
category summary (`GET /api/transactions/summary`) are shown converted into
the user's `users.currency` (default EUR) at `users.currency_scale`, null
when a rate is missing; the only place a rate becomes stored data is the
second amount of a cross-currency transfer created by statement import.

#### Transactions — single table, double-entry style

One `transactions` table covers expense, income, and transfer; the type is implied by which columns are populated — no stored `type` column:

| Type | debit_account_id | credit_account_id | category_id |
|------|------------------|-------------------|-------------|
| Expense | filled | null | required |
| Income | null | filled | required |
| Transfer | filled | filled | null |

The category column is enforced by `chk_transactions_category` (migration
015): an expense/income without a category is stored as the system
Uncategorized (ids 3 / 4), never NULL.

No per-transaction `currency` field and no stored exchange rate. Expense/
income are always denominated in the account's own currency (`debit` and `credit` are equal). Transfers
between accounts of different currencies simply carry two amounts
(`debit`, `credit`) — the implied rate is never persisted separately;
`debit` and `credit` amounts must be positive.

Visibility follows accounts, not `transactions.user_id`: a transaction is
visible when the user can reach at least one of its accounts.
`transactions.user_id` records who entered the row (or the owner who
inherited it, see account shares above) and must never be used as an access
filter. Permission checks live in the service layer via
`requireLevel` / `requireLevelOnAll`; `db/queries/*` filter by account id
only.

### Environment Variables
Copy `.env.example` → `backend/.env` (dotenv reads it from the backend's
working directory):
- `DATABASE_URL` — PostgreSQL connection string
- `DATABASE_URL_UNPOOLED` — Render only: Neon's direct endpoint, used by the
  start command for migrations
- `REGISTRATION_ENABLED` — `false` closes registration (default open)
- `TEST_DATABASE_URL` — used instead of `DATABASE_URL` by Jest when set
- `JWT_SECRET`, `JWT_REFRESH_SECRET` — token signing secrets
- `PORT` — default 3000
- `CORS_ORIGIN` — default `*`
- Optional, with working defaults: `FRANKFURTER_BASE_URL`,
  `COINGECKO_BASE_URL`, `COINGECKO_API_KEY` (rates);
  `BITCOIN_ESPLORA_URL`, `TRON_API_URL`, `TRONGRID_API_KEY`,
  `ETHEREUM_API_URL`, `ETHERSCAN_API_KEY` (wallet sync)

Dev proxy: `/api/*` → `http://localhost:3000` configured in `frontend/proxy.conf.json`

## Angular Conventions (frontend/)

This project uses Angular 22 patterns — follow these strictly:

- **Standalone components only** — no NgModules
- **`ChangeDetectionStrategy.OnPush`** required on all components
- Use `input()` / `output()` functions, not `@Input()`/`@Output()` decorators
- Use `computed()` for derived state, not getters
- Native control flow: `@if`, `@for`, `@switch` — not `*ngIf`, `*ngFor`
- Use `host` object on `@Component`, not `@HostBinding`/`@HostListener`
- Reactive forms preferred over template-driven
- No `ngClass`/`ngStyle` — use class/style bindings directly

## Testing

### Backend (Jest)
- Test files: `backend/src/test/*.test.ts`
- Setup: `backend/src/test/setup.ts` (DB fixtures), `testApp.ts` (Express test instance)
- Run single test: `npx jest --testPathPatterns=auth`

### Frontend (Vitest + jsdom)
- Tests live alongside components as `*.spec.ts`
- Run single test: `npx ng test --watch=false --include=src/app/app.spec.ts`
- Always run via `ng test` (the `@angular/build:unit-test` builder), never bare `npx vitest run` — raw vitest bypasses the builder config that wires up Zone.js/TestBed globals and JIT compilation

## Behavioral guidelines

Behavioral guidelines to reduce common LLM coding mistakes. Merge with project-specific instructions as needed.

**Tradeoff:** These guidelines bias toward caution over speed. For trivial tasks, use judgment.

### 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

### 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

### 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

### 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.
