# Swarmer Finance

A personal finance application for tracking income, expenses, and transfers across multiple accounts.

## Features

- Account management (name, currency, starting balance)
- Transaction management with double-entry bookkeeping (debit/credit)
- Three transaction types: **expense**, **income**, **transfer** — derived from account references
- Cross-currency transfers (debit ≠ credit when currencies differ)
- Hierarchical categories with parent/child support
- JWT authentication (access + refresh tokens)
- Filtering transactions by date range, category, and type

## Tech Stack

**Backend**
- Node.js + Express.js (TypeScript, strict mode)
- PostgreSQL — raw SQL, no ORM
- JWT (15min access token, 7d refresh token)
- Zod request validation

**Frontend**
- Angular 21 (standalone components, OnPush change detection)
- Taiga UI v5
- Angular Signals + `resource()` API for state and async data

## Prerequisites

- [Docker](https://docs.docker.com/get-docker/) and Docker Compose, **or**
- Node.js 18+ and PostgreSQL 15+

## Quick Start (Docker)

```bash
git clone <repo-url>
cd swarmer-finance
docker-compose up --build
```

| Service  | URL                   |
|----------|-----------------------|
| Frontend | http://localhost:80   |
| Backend  | http://localhost:3000 |
| Database | localhost:5432        |

## Local Development (without Docker)

**1. Configure environment**

```bash
cp .env.example backend/.env
# Edit backend/.env with your PostgreSQL credentials
```

**2. Backend**

```bash
cd backend
npm install
npm run migrate   # run database migrations
npm run dev       # start dev server on port 3000
```

**3. Frontend**

```bash
cd frontend
npm install
npm start         # dev server on http://localhost:4200
```

> The frontend dev server proxies `/api/*` requests to `http://localhost:3000` via `proxy.conf.json`.

## Environment Variables

```env
DATABASE_URL=postgresql://user:password@localhost:5432/finance_db
JWT_SECRET=your_secret_here_min_32_characters_long
JWT_REFRESH_SECRET=your_refresh_secret_here_min_32_characters_long
PORT=3000
```

## Available Scripts

**Backend** (`cd backend`)

| Script | Description |
|--------|-------------|
| `npm run dev` | Start development server with hot-reload |
| `npm run build` | Compile TypeScript to `dist/` |
| `npm start` | Run compiled production build |
| `npm run migrate` | Execute pending database migrations |
| `npm test` | Run Jest tests |
| `npm run test:coverage` | Run tests with coverage report |

**Frontend** (`cd frontend`)

| Script | Description |
|--------|-------------|
| `npm start` | Start Angular dev server on port 4200 |
| `npm run build` | Production build to `dist/` |
| `npm test` | Run Vitest unit tests |

## API Endpoints

All responses use the format `{ data: T | null, error: string | null }`.  
All endpoints except `/api/auth/*` require a `Bearer` JWT token.

| Method | Endpoint | Description |
|--------|----------|-------------|
| POST | `/api/auth/register` | Register a new user |
| POST | `/api/auth/login` | Login, returns access + refresh tokens |
| POST | `/api/auth/refresh` | Refresh access token |
| GET | `/api/categories` | List all categories |
| POST | `/api/categories` | Create a category |
| PUT | `/api/categories/:id` | Update a category |
| DELETE | `/api/categories/:id` | Delete a category |
| GET | `/api/accounts` | List accounts |
| POST | `/api/accounts` | Create an account |
| PUT | `/api/accounts/:id` | Update an account |
| DELETE | `/api/accounts/:id` | Delete an account |
| GET | `/api/transactions` | List transactions (supports `?from=&to=&category=&type=&page=&limit=`) |
| POST | `/api/transactions` | Create a transaction |
| PUT | `/api/transactions/:id` | Update a transaction |
| DELETE | `/api/transactions/:id` | Delete a transaction |
| GET | `/api/health` | Health check |

### Transaction Types

Transactions use double-entry bookkeeping. The type is derived from which account references are populated:

| Type | `debit_account_id` | `credit_account_id` | `currency` | `category_id` |
|------|-------------------|---------------------|------------|---------------|
| Expense | filled | null | credit currency | required (leaf) |
| Income | null | filled | debit currency | required (leaf) |
| Transfer | filled | filled | null | null |

When both accounts share the same currency `debit == credit`; otherwise they differ by the exchange rate.

All monetary values (`debit`, `credit`, `start_balance`) are stored as **integer cents** (e.g. `1000` = $10.00).

## Project Structure

```
swarmer-finance/
├── backend/
│   └── src/
│       ├── routes/        # Express route handlers (auth, categories, accounts, transactions)
│       ├── services/      # Business logic
│       ├── db/
│       │   ├── migrations/ # Numbered SQL migration files (001–005)
│       │   └── queries/    # Raw SQL query functions
│       ├── middleware/    # auth, error handler, validation
│       └── types/         # Shared TypeScript interfaces
├── frontend/
│   └── src/app/
│       ├── core/          # Auth service, interceptor, guards, state (categories, accounts)
│       ├── models/        # TypeScript interfaces (Category, Account, Transaction)
│       └── features/      # Feature components (auth, header, categories, accounts, dashboard)
├── docker-compose.yml
├── Dockerfile
└── render.yaml            # Render.com deployment config
```

## Deployment

The project is configured for [Render.com](https://render.com) deployment via `render.yaml`. It provisions a PostgreSQL database and runs the app as a single Docker container (Nginx serves the frontend and proxies `/api/*` to the backend).

```bash
# Deploy to Render: connect the repo and Render picks up render.yaml automatically
```
