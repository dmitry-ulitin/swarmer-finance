# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A personal finance management web app: multi-user, with per-account sharing
(read / write / admin) between users; permissions are granted by direct SQL
for now, with no UI. Core scope for now: income/expense transactions with
hierarchical categories, multi-currency accounts, manual entry (CSV
bank-statement import planned, not built). Investments/assets and
analytics/reports are deferred to later phases.

Local-only deployment for now; no hosted/prod environment exists.## Commands

### Backend (`/backend`)
```bash
npm run dev          # Dev server with hot-reload (tsx)
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
docker-compose up --build   # Start local PostgreSQL
```

## Architecture

### Monorepo Structure
- `backend/` — Node.js + Express + PostgreSQL (raw SQL, no ORM)
- `frontend/` — Angular 22 standalone components + Taiga UI v5
- `docker-compose.yml` — local Postgres 17 (db: finance_db, localhost:5432)

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

### Frontend State Management
- **AuthService** (`core/auth.service.ts`): Signal-based `accessToken`, `userSignal`, computed `isAuthenticated`
- **CategoriesState** (`core/categories.state.ts`): Angular `resource()` API for async loading + computed hierarchical structure
- **AccountsState** (`core/accounts.state.ts`): Same pattern as CategoriesState — flat list of user accounts
- **ApiService** (`core/api.service.ts`): Thin HttpClient wrapper

### Database
- Migrations in `backend/src/db/migrations/` — run in order (001→014)
- Raw SQL queries in `backend/src/db/queries/`
- System root categories (Income id=1, Expenses id=2) seeded in migration 002; `user_id` is NULL for system categories
- Categories support parent/child hierarchy via `parent_id`; `root_id` tracks the Income/Expenses root
- Accounts table added in migration 003 (`name`, `currency`, `start_balance`); `start_balance` stored as **INTEGER cents** (e.g. 1000 = $10.00)
- An account's `scale` (decimal places of its stored integers) is set by the
  backend from the currency (`services/currencyScale.ts`: ISO minor units,
  BTC/ETH 8, USDT/USDC/TRX 6, SOL/TON 9); the API does not accept it, and a
  currency change that would rescale existing transactions is refused.
- Transactions created in migration 004: `debit`/`credit` stored as **INTEGER cents**; `debit_account_id` and `credit_account_id` (both nullable); `category_id` (nullable)
- `account_shares` added in migration 009: `(account_id, user_id, level)`,
  level 1 = read, 2 = transactions, 3 = admin. The owner is **not** stored
  there — `accounts.user_id` is the only source of ownership, and
  `services/access.ts` synthesises level 4 (owner) for owned accounts.
  Granting someone level 3 makes the account co-owned: it then resolves to
  level 3 for its owner too, so level 4 means "personal account".
- Clean-up for mistaken/test accounts (ADMIN on the account, WRITE on every
  transfer peer): `DELETE /api/accounts/:id/transactions` removes all its
  transactions, `DELETE /api/accounts/:id?withTransactions=true` also removes
  the account. Transfers are never deleted but left to the other account as
  Uncategorized income/expense (`services/accounts.ts` `purgeAccount`).
- System category **Network fees** (id 5, under Expenses) seeded in
  migration 012; ids 1–5 are protected from edit/delete.

#### Blockchain-synced (tracked) accounts

A `crypto` account with `settings.address` and a supported
`settings.blockchain` (today `bitcoin` and `tron`, see
`services/chain/index.ts`) is *tracked*: `POST /api/accounts/:id/sync` loads
its history through a chain provider (`services/chain/bitcoin.ts`, Esplora
at `BITCOIN_ESPLORA_URL`; `services/chain/tron.ts`, TronGrid at
`TRON_API_URL`) and
`services/chainSync.ts` writes it, identified by `import_hash` (`txid`,
`txid:out`, `txid:fee`); `chain_seen_txids` (migration 013) records which
txids each account's own sync has processed, which is what paging stops on. Tracked accounts start at 0 in one of the chain's currencies (TRON: `TRX`
or `USDT`, each synced separately; TRON fees always land on the TRX account);
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

#### Transactions — single table, double-entry style

One `transactions` table covers expense, income, and transfer; the type is implied by which columns are populated — no stored `type` column:

| Type | debit_account_id | credit_account_id | category_id |
|------|------------------|-------------------|-------------|
| Expense | filled | null | required |
| Income | null | filled | required |
| Transfer | filled | filled | null |

No per-transaction `currency` field and no stored exchange rate. Expense/
income are always denominated in the account's own currency (`debit` and `credit` are equal). Transfers
between accounts of different currencies simply carry two amounts
(`debit`, `credit`) — the implied rate is never persisted separately;
`debit` and `credit` amounts must be positive.

Visibility follows accounts, not `transactions.user_id`: a transaction is
visible when the user can reach at least one of its accounts.
`transactions.user_id` records who entered the row and must never be used as
an access filter. Permission checks live in the service layer via
`requireLevel` / `requireLevelOnAll`; `db/queries/*` filter by account id
only.

### Environment Variables
Copy `.env.example` → `.env`:
- `DATABASE_URL` — PostgreSQL connection string
- `JWT_SECRET`, `JWT_REFRESH_SECRET` — token signing secrets
- `PORT` — default 3000
- `CORS_ORIGIN` — default `*`

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
