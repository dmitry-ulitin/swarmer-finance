# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

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
docker-compose up --build   # Start backend + frontend + PostgreSQL
```

## Architecture

### Monorepo Structure
- `backend/` — Node.js + Express + PostgreSQL (raw SQL, no ORM)
- `frontend/` — Angular 21 standalone components + Taiga UI v5
- `docker-compose.yml` / `Dockerfile` — multi-stage production build; `start.sh` generates Nginx config dynamically at container startup for Render.com compatibility

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
- Transactions created in migration 004: `debit`/`credit` stored as **INTEGER cents**; `debit_account_id` and `credit_account_id` (both nullable); `category_id` and `currency` are nullable

### Transaction Type Semantics
Type is derived at runtime — no stored `type` column:

| Type | `debit_account_id` | `credit_account_id` | `currency` | `category_id` |
|------|-------------------|---------------------|------------|---------------|
| Expense | filled | null | credit currency | required (leaf) |
| Income | null | filled | debit currency | required (leaf) |
| Transfer | filled | filled | null | null |

### Environment Variables
Copy `.env.example` → `.env`:
- `DATABASE_URL` — PostgreSQL connection string
- `JWT_SECRET`, `JWT_REFRESH_SECRET` — token signing secrets
- `PORT` — default 3000
- `CORS_ORIGIN` — default `*`

Dev proxy: `/api/*` → `http://localhost:3000` configured in `frontend/proxy.conf.json`

## Angular Conventions (frontend/)

This project uses Angular 21 patterns — follow these strictly:

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
