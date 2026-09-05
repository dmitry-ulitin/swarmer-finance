# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

A personal finance management web app: multi-user, private per-user data (no
sharing/invites yet — deferred, not built). Core scope for now: income/expense
transactions with hierarchical categories, multi-currency accounts, manual
entry (CSV bank-statement import planned, not built). Investments/assets and
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
- Migrations in `backend/src/db/migrations/` — run in order (001→004)
- Raw SQL queries in `backend/src/db/queries/`
- System root categories (Income id=1, Expenses id=2) seeded in migration 002; `user_id` is NULL for system categories
- Categories support parent/child hierarchy via `parent_id`; `root_id` tracks the Income/Expenses root
- Accounts table added in migration 003 (`name`, `currency`, `start_balance`); `start_balance` stored as **INTEGER cents** (e.g. 1000 = $10.00)
- Transactions created in migration 004: `debit`/`credit` stored as **INTEGER cents**; `debit_account_id` and `credit_account_id` (both nullable); `category_id` (nullable)

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
- Run single test: `npx jest --testPathPattern=auth`

### Frontend (Vitest + jsdom)
- Tests live alongside components as `*.spec.ts`
- Run single test: `npx vitest run --reporter=verbose src/app/app.spec.ts`
