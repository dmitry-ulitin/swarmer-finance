# Swarmer Finance

A personal finance application for tracking income, expenses, and transfers across multiple accounts.

## Features

- Accounts of three types (cash, bank, crypto) in any currency, with a starting balance
- Account sharing between users: read, transactions or admin access; admins can co-own an account
- Transaction management with double-entry bookkeeping (debit/credit)
- Three transaction types: **expense**, **income**, **transfer** — derived from account references
- Cross-currency transfers (debit ≠ credit when currencies differ)
- Balances and the category summary converted into the user's currency (Frankfurter/ECB rates, CoinGecko fallback)
- Hierarchical categories with parent/child support
- Bank-statement import (CSV, XLS, XLSX) for LHV, Bank of Cyprus, Alfa-Bank, CaixaBank and UniCredit, with duplicate detection and category suggestions learned from history
- Blockchain wallet sync for Bitcoin, TRON (TRX, USDT) and Ethereum (ETH, USDT)
- JWT authentication (access + refresh tokens)
- Filtering transactions by date range, accounts, categories, type and text

## Tech Stack

**Backend**
- Node.js + Express 5 (TypeScript, strict mode)
- PostgreSQL — raw SQL, no ORM
- JWT (15min access token, 7d refresh token)
- Zod request validation

**Frontend**
- Angular 22 (standalone components, OnPush change detection)
- Taiga UI v5
- Angular Signals + `resource()` API for state and async data

## Prerequisites

- Node.js 22.22+ (or 24.15+), as required by Angular 22
- [Docker](https://docs.docker.com/get-docker/) and Docker Compose for the database, **or** a local PostgreSQL 15+

## Local Development

```bash
git clone <repo-url>
cd swarmer-finance
```

**1. Start PostgreSQL**

```bash
docker-compose up -d
```

This starts Postgres 15 on `localhost:5432` with database `finance_db`, user `finance_user`, password `123456`.

**2. Configure environment**

```bash
cp .env.example backend/.env
# Edit backend/.env: set the password in DATABASE_URL (123456 for the Docker database) and the JWT secrets
```

**3. Backend**

```bash
cd backend
npm install
npm run migrate   # run database migrations
npm run dev       # start dev server on port 3000 (no watch — restart after changes)
```

**4. Frontend**

```bash
cd frontend
npm install
npm start         # dev server on http://localhost:4200
```

> The frontend dev server proxies `/api/*` requests to `http://localhost:3000` via `proxy.conf.json`.

## Environment Variables

Required:

```env
DATABASE_URL=postgresql://finance_user:password@localhost:5432/finance_db
JWT_SECRET=your_secret_here_min_32_characters_long
JWT_REFRESH_SECRET=your_refresh_secret_here_min_32_characters_long
PORT=3000
```

Optional (defaults work without them):

| Variable | Purpose |
|----------|---------|
| `CORS_ORIGIN` | Allowed origin, default `*` |
| `TEST_DATABASE_URL` | Database for Jest tests, used instead of `DATABASE_URL` |
| `FRANKFURTER_BASE_URL` | Exchange rates (ECB), default `https://api.frankfurter.dev/v1` |
| `COINGECKO_BASE_URL`, `COINGECKO_API_KEY` | Rates Frankfurter lacks (crypto, RUB, …); a free demo key raises the rate limit |
| `BITCOIN_ESPLORA_URL` | Bitcoin wallet sync, default `https://mempool.space/api` |
| `TRON_API_URL`, `TRONGRID_API_KEY` | TRON wallet sync, default `https://api.trongrid.io` |
| `ETHEREUM_API_URL`, `ETHERSCAN_API_KEY` | Ethereum wallet sync: Etherscan v2 when the key is set, else Blockscout (`https://eth.blockscout.com/api`) |

## Available Scripts

**Backend** (`cd backend`)

| Script | Description |
|--------|-------------|
| `npm run dev` | Start development server (tsx, no watch) |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run compiled production build |
| `npm run migrate` | Execute pending database migrations |
| `npm test` | Run Jest tests |
| `npm run test:watch` | Run Jest in watch mode |
| `npm run test:coverage` | Run tests with coverage report |

**Frontend** (`cd frontend`)

| Script | Description |
|--------|-------------|
| `npm start` | Start Angular dev server on port 4200 |
| `npm run build` | Production build to `dist/` |
| `npm test` | Run Vitest unit tests (via `ng test`) |

## API Endpoints

All responses use the format `{ data: T | null, error: string | null }`.  
All endpoints except `/api/auth/*` and `/api/health` require a `Bearer` JWT token.

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/register` | Register a new user |
| POST | `/api/auth/login` | Login, returns access + refresh tokens |
| POST | `/api/auth/refresh` | Refresh access token |
| GET | `/api/categories` | List all categories |
| POST | `/api/categories` | Create a category |
| PUT | `/api/categories/:id` | Update a category |
| GET | `/api/categories/:id/delete-preview` | What deleting the category would move, or why it is refused |
| DELETE | `/api/categories/:id` | Delete a category |
| GET | `/api/accounts` | List accounts (own and shared) |
| POST | `/api/accounts` | Create an account |
| PUT | `/api/accounts/:id` | Update an account |
| DELETE | `/api/accounts/:id` | Delete an account (`?withTransactions=true` also removes its transactions) |
| DELETE | `/api/accounts/:id/transactions` | Remove all transactions of an account |
| POST | `/api/accounts/:id/sync` | Sync a blockchain-tracked account |
| GET | `/api/accounts/:id/shares` | List account members |
| POST | `/api/accounts/:id/shares` | Share an account with a user |
| PUT | `/api/accounts/:id/shares/:userId` | Change a member's access level |
| DELETE | `/api/accounts/:id/shares/:userId` | Remove a member (or leave) |
| GET | `/api/transactions` | List transactions (supports `?from=&to=&accounts=&categories=&details=&type=&offset=&limit=`; `accounts`/`categories` repeat for several ids) |
| GET | `/api/transactions/summary` | Income/expense totals by top-level category (supports `?from=&to=&accounts=`) |
| POST | `/api/transactions` | Create a transaction |
| PUT | `/api/transactions/:id` | Update a transaction |
| DELETE | `/api/transactions/:id` | Delete a transaction |
| POST | `/api/import/parse` | Parse a bank statement and mark duplicates |
| POST | `/api/import/reconcile` | Import the reviewed statement rows |
| GET | `/api/health` | Health check |

### Transaction Types

Transactions use double-entry bookkeeping. The type is derived from which account references are populated:

| Type | `debit_account_id` | `credit_account_id` | `category_id` |
|------|--------------------|---------------------|---------------|
| Expense | filled | null | required |
| Income | null | filled | required |
| Transfer | filled | filled | null |

An expense or income without a category is stored as the system *Uncategorized*.
When both accounts share the same currency `debit == credit`; otherwise they differ by the exchange rate.

Monetary values (`debit`, `credit`, `start_balance`) are stored as integers at the account's scale — the currency's decimal places (2 for most fiat, 8 for BTC/ETH, 6 for USDT/TRX). The API takes and returns decimal amounts.

## Project Structure

```
swarmer-finance/
├── backend/
│   ├── scripts/           # One-off SQL for migrating legacy data
│   └── src/
│       ├── routes/        # Express route handlers (auth, categories, accounts, transactions, import)
│       ├── services/      # Business logic
│       │   ├── chain/     # Blockchain providers (Bitcoin, TRON, Ethereum)
│       │   ├── import/    # Statement parsing, bank profiles, category suggestions
│       │   └── rates/     # Exchange-rate providers (Frankfurter, CoinGecko)
│       ├── db/
│       │   ├── migrations/ # Numbered SQL migration files (001–017)
│       │   └── queries/    # Raw SQL query functions
│       ├── middleware/    # auth, error handler, validation
│       ├── types/         # Shared TypeScript interfaces
│       └── test/          # Jest tests and fixtures
├── frontend/
│   └── src/app/
│       ├── core/          # Auth, interceptor, guards, state (accounts, categories, transactions), money helpers
│       ├── models/        # TypeScript interfaces (Account, Category, Transaction, Import)
│       └── features/      # Feature components (auth, header, dashboard, accounts, categories,
│                          #   category-summary, filters-bar, transactions, import)
├── docs/superpowers/      # Design specs and implementation plans
└── docker-compose.yml     # Local PostgreSQL
```
