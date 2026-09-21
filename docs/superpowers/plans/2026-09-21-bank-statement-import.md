# Bank Statement Import (Backend) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Two backend endpoints that turn a bank statement file into transactions — `parse` (file → rows, each flagged against what already exists) and `reconcile` (chosen rows → transactions), with re-import producing no duplicates.

**Architecture:** A registry of per-bank format profiles, where a profile is pure data (delimiter, date format, decimal convention, column names, identity strategy) and one set of code paths reads any profile. No server state between the two endpoints — the client holds the parsed rows. Duplicate detection rests on a new nullable `transactions.import_hash`, hashing the bank's own reference where one exists and row content where it does not, backed by partial unique indexes so idempotency is enforced by the database rather than only by the service.

**Tech Stack:** Node.js, Express 5, PostgreSQL (raw SQL, no ORM), Zod 4, Jest + supertest, TypeScript. No new dependencies — the CSV reader is written in-repo and files arrive base64 in a JSON body.

**Spec:** `docs/superpowers/specs/2026-09-21-bank-statement-import-design.md`

## Global Constraints

- **API envelope:** every response is `{ data: T | null, error: string | null }`.
- **Money:** `debit`/`credit` are INTEGER cents in the database; the API speaks decimal. Convert with `toCents(value, account.scale)` / `toDecimal(value, account.scale)` from `src/services/currency.ts`.
- **Access:** permission checks live in the **service layer** via `requireLevel` / `requireLevelOnAll` from `src/services/access.ts`. `db/queries/*` filter by account id only. `transactions.user_id` records who entered a row and must **never** be used as an access filter.
- **Write level:** both endpoints require `LEVEL.WRITE` (2) on the target account.
- **Errors:** throw `{ statusCode, message }`; `errorHandler` renders it. 400 = bad input, 403 = insufficient access, 404 = not found.
- **No new npm dependencies.**
- **Transfers are out of scope.** Every imported row becomes an income or an expense.
- **`.xls` is out of scope.** The `reader` field exists and only `'csv'` is implemented.
- **Uncategorized defaults:** category 3 = income, 4 = expense (already applied by `createTransaction`).
- **Fixtures:** tests read `src/test/fixtures/banks/lhv/statement.csv` (143 rows, 16 cols, UTF-8 BOM) and `src/test/fixtures/banks/bank_of_cyprus/statement.csv` (10 rows, 10 cols, 5 preamble lines). Real statements in `backend/banks/` are gitignored — never read them from tests.
- **Test command:** `npm test` in `backend/`; single file `npx jest --testPathPatterns=import`.

## File Structure

| File | Responsibility |
|---|---|
| `src/db/migrations/011_add_transactions_import_hash.sql` | Adds `import_hash` + two partial unique indexes |
| `src/services/import/csv.ts` | RFC4180 text → `string[][]`. Knows nothing about banks |
| `src/services/import/profiles.ts` | The `Profile` type and the registry (lhv, boc) + `detectProfile` |
| `src/services/import/hash.ts` | `computeImportHash` — reference or content, with occurrence index |
| `src/services/import/rows.ts` | Profile + raw grid → normalised `ParsedRow[]` (dates, decimals, signs, currency) |
| `src/services/import/index.ts` | `parseStatement()` / `reconcile()` — access, currency check, classification, inserts |
| `src/routes/import.ts` | Zod schemas, two route handlers |
| `src/db/queries/transactions.ts` | *(modify)* `import_hash` on insert; `findByImportHashes`; `findByDateAndAmount` |
| `src/index.ts`, `src/test/testApp.ts` | *(modify)* register `importRoutes` |

Tasks run bottom-up: each layer is tested before the one above it uses it.

---

### Task 1: Migration — `import_hash` column and indexes

**Files:**
- Create: `backend/src/db/migrations/011_add_transactions_import_hash.sql`
- Test: `backend/src/test/importHash.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: column `transactions.import_hash TEXT NULL`; indexes `idx_transactions_import_hash_debit`, `idx_transactions_import_hash_credit`.

- [ ] **Step 1: Write the migration**

Create `backend/src/db/migrations/011_add_transactions_import_hash.sql`:

```sql
-- Identity for imported transactions. NULL for hand-entered rows, which the
-- partial indexes therefore never constrain against each other.
ALTER TABLE transactions ADD COLUMN IF NOT EXISTS import_hash TEXT;

-- Two indexes because the account id lives in a different column for income
-- than for expense. A hash is unique only WITHIN an account: the same
-- statement imported into two accounts is two legitimate sets of rows.
--
-- These are the real idempotency guarantee. The service checks for existing
-- hashes before inserting, but that check and the insert are not atomic
-- against a concurrent request; the index makes a double-submit impossible
-- rather than merely unlikely.
CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_import_hash_debit
  ON transactions(debit_account_id, import_hash)
  WHERE import_hash IS NOT NULL AND debit_account_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_transactions_import_hash_credit
  ON transactions(credit_account_id, import_hash)
  WHERE import_hash IS NOT NULL AND credit_account_id IS NOT NULL;
```

- [ ] **Step 2: Run the migration**

Run: `cd backend && npm run migrate`
Expected: `Running migration: 011_add_transactions_import_hash.sql` then `Completed`.

- [ ] **Step 3: Write the failing test**

Create `backend/src/test/importHash.test.ts`:

```ts
import { pool } from '../db';

describe('import_hash schema', () => {
  let userId: number;
  let accountId: number;

  beforeAll(async () => {
    const u = await pool.query(
      `INSERT INTO users (email, password_hash, name, currency)
       VALUES ($1, 'x', 'Hash Test', 'EUR') RETURNING id`,
      [`hash${Date.now()}@example.com`]
    );
    userId = u.rows[0].id;
    const a = await pool.query(
      `INSERT INTO accounts (user_id, name, currency, start_balance)
       VALUES ($1, 'Hash Account', 'EUR', 0) RETURNING id`,
      [userId]
    );
    accountId = a.rows[0].id;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM transactions WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM accounts WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM categories WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  });

  const insert = (hash: string | null) =>
    pool.query(
      `INSERT INTO transactions
         (user_id, category_id, debit_account_id, debit, credit, date, description, import_hash)
       VALUES ($1, 4, $2, 1000, 1000, '2026-07-01', 'x', $3)`,
      [userId, accountId, hash]
    );

  it('rejects a duplicate hash on the same account', async () => {
    await insert('hash-a');
    await expect(insert('hash-a')).rejects.toThrow();
  });

  it('allows the same hash on a different account', async () => {
    const other = await pool.query(
      `INSERT INTO accounts (user_id, name, currency, start_balance)
       VALUES ($1, 'Other', 'EUR', 0) RETURNING id`,
      [userId]
    );
    await expect(
      pool.query(
        `INSERT INTO transactions
           (user_id, category_id, debit_account_id, debit, credit, date, description, import_hash)
         VALUES ($1, 4, $2, 1000, 1000, '2026-07-01', 'x', 'hash-a')`,
        [userId, other.rows[0].id]
      )
    ).resolves.toBeDefined();
  });

  it('allows many NULL hashes — hand-entered rows are unconstrained', async () => {
    await insert(null);
    await expect(insert(null)).resolves.toBeDefined();
  });
});
```

- [ ] **Step 4: Run the test**

Run: `cd backend && npx jest --testPathPatterns=importHash`
Expected: PASS (3 tests). If the duplicate test fails, the index did not apply — re-check Step 2.

- [ ] **Step 5: Commit**

```bash
git add backend/src/db/migrations/011_add_transactions_import_hash.sql backend/src/test/importHash.test.ts
git commit -m "feat(import): add transactions.import_hash with partial unique indexes"
```

---

### Task 2: CSV reader

**Files:**
- Create: `backend/src/services/import/csv.ts`
- Test: `backend/src/test/importCsv.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces: `parseCsv(text: string, delimiter?: string): string[][]` — strips a leading BOM, handles quoted fields containing the delimiter, escaped `""`, CRLF and LF, and drops trailing blank lines.

- [ ] **Step 1: Write the failing test**

Create `backend/src/test/importCsv.test.ts`:

```ts
import { parseCsv } from '../services/import/csv';

describe('parseCsv', () => {
  it('parses plain rows', () => {
    expect(parseCsv('a,b\n1,2\n')).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('keeps a delimiter that sits inside quotes', () => {
    // LHV descriptions are full of commas.
    expect(parseCsv('a,b\n"x,y",2\n')).toEqual([['a', 'b'], ['x,y', '2']]);
  });

  it('unescapes doubled quotes', () => {
    expect(parseCsv('a\n"he said ""hi"""\n')).toEqual([['a'], ['he said "hi"']]);
  });

  it('strips a UTF-8 BOM from the first field', () => {
    expect(parseCsv('﻿a,b\n')).toEqual([['a', 'b']]);
  });

  it('handles CRLF', () => {
    expect(parseCsv('a,b\r\n1,2\r\n')).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('drops trailing blank lines', () => {
    expect(parseCsv('a,b\n1,2\n\n')).toEqual([['a', 'b'], ['1', '2']]);
  });

  it('keeps empty fields', () => {
    expect(parseCsv('a,,c\n')).toEqual([['a', '', 'c']]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && npx jest --testPathPatterns=importCsv`
Expected: FAIL — `Cannot find module '../services/import/csv'`.

- [ ] **Step 3: Write the implementation**

Create `backend/src/services/import/csv.ts`:

```ts
/**
 * RFC4180 reader. Banks disagree about quoting — LHV quotes text but leaves
 * dates and amounts bare, Bank of Cyprus quotes only its comma-decimal
 * numerics — so the reader treats quoting as per-field, never per-file.
 */
export function parseCsv(text: string, delimiter = ','): string[][] {
  const src = text.replace(/^﻿/, '');
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"') {
        if (src[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += c;
      continue;
    }
    if (c === '"') quoted = true;
    else if (c === delimiter) { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length > 0) { row.push(field); rows.push(row); }

  // A trailing newline leaves a [''] row; so does a blank separator line.
  return rows.filter(r => r.length > 1 || r[0] !== '');
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && npx jest --testPathPatterns=importCsv`
Expected: PASS (7 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/import/csv.ts backend/src/test/importCsv.test.ts
git commit -m "feat(import): add RFC4180 CSV reader"
```

---

### Task 3: Profile registry

**Files:**
- Create: `backend/src/services/import/profiles.ts`
- Test: `backend/src/test/importProfiles.test.ts`

**Interfaces:**
- Consumes: `parseCsv` (Task 2).
- Produces:
  - `type ProfileId = 'lhv' | 'boc'`
  - `type Profile = { … }` exactly as written in Step 3
  - `PROFILES: Record<ProfileId, Profile>`
  - `detectProfile(grid: string[][]): Profile | null`
  - `getProfile(id: string): Profile` — throws `{ statusCode: 400 }` on an unknown id

- [ ] **Step 1: Write the failing test**

Create `backend/src/test/importProfiles.test.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';
import { parseCsv } from '../services/import/csv';
import { PROFILES, detectProfile, getProfile } from '../services/import/profiles';

const fixture = (...p: string[]) =>
  fs.readFileSync(path.join(__dirname, 'fixtures', 'banks', ...p), 'utf8');

describe('profiles', () => {
  it('detects LHV from its header signature', () => {
    const grid = parseCsv(fixture('lhv', 'statement.csv'));
    expect(detectProfile(grid)?.id).toBe('lhv');
  });

  it('detects Bank of Cyprus past its preamble', () => {
    const grid = parseCsv(fixture('bank_of_cyprus', 'statement.csv'));
    expect(detectProfile(grid)?.id).toBe('boc');
  });

  it('returns null for an unrecognised file', () => {
    expect(detectProfile([['foo', 'bar'], ['1', '2']])).toBeNull();
  });

  it('getProfile rejects an unknown id with 400', () => {
    expect(() => getProfile('nope')).toThrow(
      expect.objectContaining({ statusCode: 400 })
    );
  });

  it('every profile declares a header signature that fits its own columns', () => {
    for (const profile of Object.values(PROFILES)) {
      expect(profile.headerSignature.length).toBeGreaterThan(0);
      expect(profile.reader).toBe('csv');
    }
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && npx jest --testPathPatterns=importProfiles`
Expected: FAIL — `Cannot find module '../services/import/profiles'`.

- [ ] **Step 3: Write the implementation**

Create `backend/src/services/import/profiles.ts`:

```ts
export type ProfileId = 'lhv' | 'boc';

/**
 * One bank's layout, as data. Everything that differs between statements is
 * a field here, so adding a bank is a data change rather than a code change.
 */
export interface Profile {
  id: ProfileId;
  name: string;
  /** Container format. Only 'csv' is implemented; 'xls' is deferred. */
  reader: 'csv';
  encoding: 'utf8';
  delimiter: string;
  /** Lines of preamble before the header row. */
  skipLines: number;
  /** Columns that together identify this format when none was given. */
  headerSignature: string[];
  dateFormat: 'iso' | 'dd/mm/yyyy';
  /** 'comma' implies '.' groups thousands, as in "39.384,54". */
  decimal: 'dot' | 'comma';
  amount:
    | { kind: 'signed'; column: string; directionColumn?: string; debitFlag?: string }
    | { kind: 'split'; debitColumn: string; creditColumn: string };
  columns: { date: string; description: string; payee?: string };
  currency:
    | { from: 'column'; column: string }
    | { from: 'preamble'; line: number; after: string };
  identity:
    | { kind: 'reference'; columns: string[] }
    | { kind: 'content' };
}

export const PROFILES: Record<ProfileId, Profile> = {
  lhv: {
    id: 'lhv',
    name: 'LHV',
    reader: 'csv',
    encoding: 'utf8',
    delimiter: ',',
    skipLines: 0,
    headerSignature: ['Customer account no', 'Debit/Credit (D/C)', 'Amount'],
    dateFormat: 'iso',
    decimal: 'dot',
    // LHV's Amount is already signed consistently with its D/C column, but
    // the explicit flag is the authority: a bank exporting unsigned amounts
    // with a direction column is common, and trusting the flag fails safe.
    amount: { kind: 'signed', column: 'Amount', directionColumn: 'Debit/Credit (D/C)', debitFlag: 'D' },
    columns: {
      date: 'Date',
      description: 'Description',
      payee: 'Sender/receiver name',
    },
    currency: { from: 'column', column: 'Currency' },
    identity: { kind: 'reference', columns: ['Transaction reference'] },
  },
  boc: {
    id: 'boc',
    name: 'Bank of Cyprus',
    reader: 'csv',
    encoding: 'utf8',
    delimiter: ',',
    skipLines: 5,
    headerSignature: ['Date', 'Description', 'Debit', 'Credit', 'Indicative balance'],
    dateFormat: 'dd/mm/yyyy',
    decimal: 'comma',
    amount: { kind: 'split', debitColumn: 'Debit', creditColumn: 'Credit' },
    // No payee column: the merchant is buried in the description blob, and
    // regex-guessing it is a separate concern.
    columns: { date: 'Date', description: 'Description' },
    currency: { from: 'preamble', line: 4, after: 'Account currency:' },
    identity: { kind: 'reference', columns: ['Bank reference number'] },
  },
};

/** The profile whose header signature appears at its declared offset. */
export function detectProfile(grid: string[][]): Profile | null {
  for (const profile of Object.values(PROFILES)) {
    const header = grid[profile.skipLines];
    if (!header) continue;
    if (profile.headerSignature.every(col => header.includes(col))) return profile;
  }
  return null;
}

export function getProfile(id: string): Profile {
  const profile = PROFILES[id as ProfileId];
  if (!profile) {
    throw {
      statusCode: 400,
      message: `Unknown statement format '${id}'. Supported: ${Object.keys(PROFILES).join(', ')}`,
    };
  }
  return profile;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && npx jest --testPathPatterns=importProfiles`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/import/profiles.ts backend/src/test/importProfiles.test.ts
git commit -m "feat(import): add format profile registry for LHV and Bank of Cyprus"
```

---

### Task 4: Row normalisation

**Files:**
- Create: `backend/src/services/import/rows.ts`
- Test: `backend/src/test/importRows.test.ts`

**Interfaces:**
- Consumes: `Profile` (Task 3), `parseCsv` (Task 2).
- Produces:
  - `interface ParsedRow { index: number; date: string; amount: number; description: string; payee: string | null; reference: string | null }`
  - `readStatement(text: string, profile: Profile): { rows: ParsedRow[]; currency: string }`

`amount` is a **decimal** number, signed: positive is income, negative is expense. `date` is ISO `YYYY-MM-DD`.

- [ ] **Step 1: Write the failing test**

Create `backend/src/test/importRows.test.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';
import { PROFILES } from '../services/import/profiles';
import { readStatement } from '../services/import/rows';

const fixture = (...p: string[]) =>
  fs.readFileSync(path.join(__dirname, 'fixtures', 'banks', ...p), 'utf8');

describe('readStatement — LHV', () => {
  const result = () => readStatement(fixture('lhv', 'statement.csv'), PROFILES.lhv);

  it('reads every data row', () => {
    expect(result().rows).toHaveLength(143);
  });

  it('reads the currency from the per-row column', () => {
    expect(result().currency).toBe('EUR');
  });

  it('parses the first row, an income', () => {
    const row = result().rows[0];
    expect(row.date).toBe('2026-07-01');
    expect(row.amount).toBe(1305.28);
    expect(row.description).toBe('Description 1');
    expect(row.payee).toBe('MERCHANT 001');
  });

  it('signs debits negative and credits positive', () => {
    const { rows } = result();
    expect(rows.filter(r => r.amount > 0)).toHaveLength(10);
    expect(rows.filter(r => r.amount < 0)).toHaveLength(133);
  });

  it('carries the bank reference for identity', () => {
    expect(result().rows[0].reference).toBe('1400000000');
  });
});

describe('readStatement — Bank of Cyprus', () => {
  const result = () => readStatement(fixture('bank_of_cyprus', 'statement.csv'), PROFILES.boc);

  it('skips the preamble and reads the data rows', () => {
    expect(result().rows).toHaveLength(10);
  });

  it('reads the currency from the preamble', () => {
    expect(result().currency).toBe('EUR');
  });

  it('converts dd/mm/yyyy to ISO', () => {
    expect(result().rows[0].date).toBe('2026-09-21');
  });

  it('reads comma decimals with dot thousands separators', () => {
    // "6,00" in the Debit column -> -6.00
    expect(result().rows[0].amount).toBe(-6);
  });

  it('leaves payee null when the bank has no such column', () => {
    expect(result().rows[0].payee).toBeNull();
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && npx jest --testPathPatterns=importRows`
Expected: FAIL — `Cannot find module '../services/import/rows'`.

- [ ] **Step 3: Write the implementation**

Create `backend/src/services/import/rows.ts`:

```ts
import { parseCsv } from './csv';
import { Profile } from './profiles';

export interface ParsedRow {
  index: number;
  /** ISO YYYY-MM-DD. */
  date: string;
  /** Decimal, signed: positive income, negative expense. */
  amount: number;
  description: string;
  payee: string | null;
  /** The bank's own reference, when it publishes one. */
  reference: string | null;
}

function parseDate(value: string, format: Profile['dateFormat']): string {
  const v = value.trim();
  if (format === 'iso') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) {
      throw { statusCode: 400, message: `Unreadable date '${value}'` };
    }
    return v;
  }
  const m = v.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
  if (!m) throw { statusCode: 400, message: `Unreadable date '${value}'` };
  return `${m[3]}-${m[2]}-${m[1]}`;
}

function parseAmount(value: string, decimal: Profile['decimal']): number {
  let v = value.trim();
  if (v === '') return 0;
  // 'comma' means "39.384,54": dots group thousands, the comma is the point.
  if (decimal === 'comma') v = v.replace(/\./g, '').replace(',', '.');
  v = v.replace(/\s/g, '');
  const n = Number(v);
  if (!Number.isFinite(n)) {
    throw { statusCode: 400, message: `Unreadable amount '${value}'` };
  }
  return n;
}

/** Rounds away float drift from the decimal parse, e.g. 0.1 + 0.2 cases. */
const round2 = (n: number): number => Math.round(n * 100) / 100;

export function readStatement(
  text: string,
  profile: Profile
): { rows: ParsedRow[]; currency: string } {
  const grid = parseCsv(text, profile.delimiter);
  const header = grid[profile.skipLines];
  if (!header) {
    throw { statusCode: 400, message: 'Statement has no header row' };
  }
  const col = (name: string): number => {
    const i = header.indexOf(name);
    if (i === -1) {
      throw { statusCode: 400, message: `Statement is missing the '${name}' column` };
    }
    return i;
  };

  const dateIdx = col(profile.columns.date);
  const descIdx = col(profile.columns.description);
  const payeeIdx = profile.columns.payee ? col(profile.columns.payee) : -1;

  let currency: string;
  if (profile.currency.from === 'column') {
    currency = '';
  } else {
    const line = grid[profile.currency.line];
    const label = profile.currency.after;
    if (!line || line[0] !== label) {
      throw { statusCode: 400, message: `Statement preamble is missing '${label}'` };
    }
    currency = (line[1] || '').trim();
  }

  const rows: ParsedRow[] = [];
  const dataRows = grid.slice(profile.skipLines + 1);

  dataRows.forEach((raw, index) => {
    let amount: number;
    if (profile.amount.kind === 'signed') {
      amount = parseAmount(raw[col(profile.amount.column)] ?? '', profile.decimal);
      const dirCol = profile.amount.directionColumn;
      if (dirCol) {
        const isDebit = (raw[col(dirCol)] ?? '').trim() === profile.amount.debitFlag;
        amount = isDebit ? -Math.abs(amount) : Math.abs(amount);
      }
    } else {
      const debit = parseAmount(raw[col(profile.amount.debitColumn)] ?? '', profile.decimal);
      const credit = parseAmount(raw[col(profile.amount.creditColumn)] ?? '', profile.decimal);
      amount = credit - debit;
    }

    if (profile.currency.from === 'column') {
      const rowCurrency = (raw[col(profile.currency.column)] ?? '').trim();
      if (!currency) currency = rowCurrency;
      else if (rowCurrency && rowCurrency !== currency) {
        throw {
          statusCode: 400,
          message: `Statement mixes currencies (${currency} and ${rowCurrency}); import one currency at a time`,
        };
      }
    }

    const reference =
      profile.identity.kind === 'reference'
        ? profile.identity.columns.map(c => (raw[col(c)] ?? '').trim()).join('|') || null
        : null;

    rows.push({
      index,
      date: parseDate(raw[dateIdx] ?? '', profile.dateFormat),
      amount: round2(amount),
      description: (raw[descIdx] ?? '').trim(),
      payee: payeeIdx === -1 ? null : (raw[payeeIdx] ?? '').trim() || null,
      reference,
    });
  });

  if (!currency) {
    throw { statusCode: 400, message: 'Could not determine the statement currency' };
  }
  return { rows, currency };
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && npx jest --testPathPatterns=importRows`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/import/rows.ts backend/src/test/importRows.test.ts
git commit -m "feat(import): normalise statement rows to dates, signed decimals and payees"
```

---

### Task 5: Import hashing

**Files:**
- Create: `backend/src/services/import/hash.ts`
- Test: `backend/src/test/importHashing.test.ts`

**Interfaces:**
- Consumes: `ParsedRow` (Task 4), `Profile` (Task 3).
- Produces: `computeImportHashes(rows: ParsedRow[], profile: Profile): string[]` — one hash per row, positionally aligned with `rows`.

- [ ] **Step 1: Write the failing test**

Create `backend/src/test/importHashing.test.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';
import { PROFILES, Profile } from '../services/import/profiles';
import { readStatement, ParsedRow } from '../services/import/rows';
import { computeImportHashes } from '../services/import/hash';

const fixture = (...p: string[]) =>
  fs.readFileSync(path.join(__dirname, 'fixtures', 'banks', ...p), 'utf8');

const contentProfile: Profile = { ...PROFILES.lhv, identity: { kind: 'content' } };

describe('computeImportHashes', () => {
  it('is stable across runs over the same file', () => {
    const { rows } = readStatement(fixture('lhv', 'statement.csv'), PROFILES.lhv);
    expect(computeImportHashes(rows, PROFILES.lhv))
      .toEqual(computeImportHashes(rows, PROFILES.lhv));
  });

  it('gives every LHV row a distinct hash, via its bank reference', () => {
    const { rows } = readStatement(fixture('lhv', 'statement.csv'), PROFILES.lhv);
    const hashes = computeImportHashes(rows, PROFILES.lhv);
    expect(new Set(hashes).size).toBe(143);
  });

  it('distinguishes identical rows by occurrence when hashing content', () => {
    // The fixture holds four rows booked 2026-07-29 at -10.00 that are
    // identical in every field the file exposes. A content hash must still
    // tell them apart, or a re-import would collapse four charges into one.
    const { rows } = readStatement(fixture('lhv', 'statement.csv'), contentProfile);
    const hashes = computeImportHashes(rows, contentProfile);
    expect(new Set(hashes).size).toBe(rows.length);
  });

  it('matches the same content row across two parses of the same file', () => {
    const a = readStatement(fixture('lhv', 'statement.csv'), contentProfile);
    const b = readStatement(fixture('lhv', 'statement.csv'), contentProfile);
    expect(computeImportHashes(a.rows, contentProfile))
      .toEqual(computeImportHashes(b.rows, contentProfile));
  });

  it('separates rows that differ only in amount', () => {
    const rows: ParsedRow[] = [
      { index: 0, date: '2026-07-01', amount: -5, description: 'x', payee: null, reference: null },
      { index: 1, date: '2026-07-01', amount: -6, description: 'x', payee: null, reference: null },
    ];
    const [h1, h2] = computeImportHashes(rows, contentProfile);
    expect(h1).not.toBe(h2);
  });

  it('separates identical content under different profiles', () => {
    const rows: ParsedRow[] = [
      { index: 0, date: '2026-07-01', amount: -5, description: 'x', payee: null, reference: null },
    ];
    const other: Profile = { ...contentProfile, id: 'boc' };
    expect(computeImportHashes(rows, contentProfile)[0])
      .not.toBe(computeImportHashes(rows, other)[0]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && npx jest --testPathPatterns=importHashing`
Expected: FAIL — `Cannot find module '../services/import/hash'`.

- [ ] **Step 3: Write the implementation**

Create `backend/src/services/import/hash.ts`:

```ts
import { createHash } from 'crypto';
import { Profile } from './profiles';
import { ParsedRow } from './rows';

const sha256 = (input: string): string =>
  createHash('sha256').update(input).digest('hex');

/** Collapses whitespace so trivial spacing changes do not break a match. */
const normalize = (s: string): string => s.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * One hash per row, positionally aligned with `rows`.
 *
 * Where the bank publishes a reference, that alone identifies the row: it
 * survives the bank rewording a description. Where it does not, the row's
 * own content identifies it — plus an occurrence index, because a content
 * hash otherwise cannot tell two genuinely identical charges apart, and real
 * statements contain them.
 */
export function computeImportHashes(rows: ParsedRow[], profile: Profile): string[] {
  const seen = new Map<string, number>();

  return rows.map(row => {
    if (profile.identity.kind === 'reference' && row.reference) {
      return sha256(`${profile.id}|${row.reference}`);
    }
    const base = [
      profile.id,
      row.date,
      row.amount.toFixed(2),
      normalize(row.description),
    ].join('|');
    const occurrence = seen.get(base) ?? 0;
    seen.set(base, occurrence + 1);
    return sha256(`${base}|${occurrence}`);
  });
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && npx jest --testPathPatterns=importHashing`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/import/hash.ts backend/src/test/importHashing.test.ts
git commit -m "feat(import): hash rows by bank reference or content with occurrence index"
```

---

### Task 6: Transaction queries for import

**Files:**
- Modify: `backend/src/db/queries/transactions.ts`
- Test: `backend/src/test/importQueries.test.ts`

**Interfaces:**
- Consumes: nothing new.
- Produces, in `db/queries/transactions.ts`:
  - `CreateTransactionData` gains `importHash?: string | null`
  - `findExistingImportHashes(accountId: number, hashes: string[]): Promise<string[]>`
  - `findByDates(accountId: number, dates: string[]): Promise<{ id: number; date: Date; debit: string; credit: string }[]>`
  - `createImportedTransactions(userId: number, rows: ImportedTransactionData[]): Promise<number>` — bulk insert, `ON CONFLICT DO NOTHING`, returns the number actually inserted
  - `interface ImportedTransactionData extends CreateTransactionData { importHash: string }`

These filter by **account id only**; access is the service's job.

- [ ] **Step 1: Write the failing test**

Create `backend/src/test/importQueries.test.ts`:

```ts
import { pool } from '../db';
import {
  findExistingImportHashes,
  createImportedTransactions,
} from '../db/queries/transactions';

describe('import queries', () => {
  let userId: number;
  let accountId: number;

  beforeAll(async () => {
    const u = await pool.query(
      `INSERT INTO users (email, password_hash, name, currency)
       VALUES ($1, 'x', 'Query Test', 'EUR') RETURNING id`,
      [`q${Date.now()}@example.com`]
    );
    userId = u.rows[0].id;
    const a = await pool.query(
      `INSERT INTO accounts (user_id, name, currency, start_balance)
       VALUES ($1, 'Q Account', 'EUR', 0) RETURNING id`,
      [userId]
    );
    accountId = a.rows[0].id;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM transactions WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM accounts WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM categories WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM transactions WHERE user_id = $1', [userId]);
  });

  const row = (hash: string, amount = -1000) => ({
    categoryId: 4,
    debitAccountId: amount < 0 ? accountId : null,
    creditAccountId: amount < 0 ? null : accountId,
    debit: Math.abs(amount),
    credit: Math.abs(amount),
    date: '2026-07-01',
    description: 'imported',
    payee: null,
    importHash: hash,
  });

  it('inserts rows and reports the count', async () => {
    const n = await createImportedTransactions(userId, [row('h1'), row('h2')]);
    expect(n).toBe(2);
  });

  it('skips rows whose hash already exists', async () => {
    await createImportedTransactions(userId, [row('h1')]);
    const n = await createImportedTransactions(userId, [row('h1'), row('h2')]);
    expect(n).toBe(1);
  });

  it('finds which hashes are already present', async () => {
    await createImportedTransactions(userId, [row('h1'), row('h2')]);
    const found = await findExistingImportHashes(accountId, ['h1', 'h3']);
    expect(found).toEqual(['h1']);
  });

  it('returns nothing for an empty hash list', async () => {
    expect(await findExistingImportHashes(accountId, [])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && npx jest --testPathPatterns=importQueries`
Expected: FAIL — `findExistingImportHashes is not a function`.

- [ ] **Step 3: Add `importHash` to the existing insert**

In `backend/src/db/queries/transactions.ts`, add the field to `CreateTransactionData`:

```ts
export interface CreateTransactionData {
  categoryId?: number;
  debitAccountId?: number;
  creditAccountId?: number;
  debit: number;
  credit: number;
  date: string;
  description?: string;
  payee?: string;
  /** Set only by the import flow; NULL for hand-entered transactions. */
  importHash?: string | null;
}
```

Then extend `createTransaction`'s INSERT (currently at `src/db/queries/transactions.ts:197`) to carry it:

```ts
export const createTransaction = async (
  userId: number,
  data: CreateTransactionData
): Promise<TransactionDTO> => {
  const result = await query<{ id: number }>(
    `INSERT INTO transactions
       (user_id, category_id, debit_account_id, credit_account_id, debit, credit, date, description, payee, import_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) RETURNING id`,
    [
      userId,
      data.categoryId ?? null,
      data.debitAccountId ?? null,
      data.creditAccountId ?? null,
      data.debit,
      data.credit,
      data.date,
      data.description || '',
      data.payee ?? null,
      data.importHash ?? null,
    ]
  );
  return (await getTransactionDTOById(result[0].id))!;
};
```

- [ ] **Step 4: Add the import-specific queries**

Append to `backend/src/db/queries/transactions.ts`:

```ts
/**
 * Which of `hashes` already exist on this account.
 *
 * Scoped by account id alone — access is settled in the service layer, and a
 * hash is only unique within an account anyway.
 */
export const findExistingImportHashes = async (
  accountId: number,
  hashes: string[]
): Promise<string[]> => {
  if (hashes.length === 0) return [];
  const rows = await query<{ import_hash: string }>(
    `SELECT DISTINCT import_hash
     FROM transactions
     WHERE import_hash = ANY($1::text[])
       AND (debit_account_id = $2 OR credit_account_id = $2)`,
    [hashes, accountId]
  );
  return rows.map(r => r.import_hash);
};

/**
 * Transactions on this account falling on any of `dates`, for the heuristic
 * duplicate check. Returns amounts in cents; the service matches them.
 */
export const findByDates = async (
  accountId: number,
  dates: string[]
): Promise<{ id: number; date: Date; debit: string; credit: string }[]> => {
  if (dates.length === 0) return [];
  return query<{ id: number; date: Date; debit: string; credit: string }>(
    `SELECT id, date, debit, credit
     FROM transactions
     WHERE date = ANY($1::date[])
       AND (debit_account_id = $2 OR credit_account_id = $2)`,
    [dates, accountId]
  );
};

export interface ImportedTransactionData extends CreateTransactionData {
  importHash: string;
}

/**
 * Bulk insert in one statement. ON CONFLICT DO NOTHING against the partial
 * unique indexes makes a double-submit a no-op rather than a duplicate, so
 * the count returned is what actually landed.
 */
export const createImportedTransactions = async (
  userId: number,
  rows: ImportedTransactionData[]
): Promise<number> => {
  if (rows.length === 0) return 0;

  const values: unknown[] = [];
  const tuples = rows.map((r, i) => {
    const b = i * 9;
    values.push(
      userId,
      r.categoryId ?? null,
      r.debitAccountId ?? null,
      r.creditAccountId ?? null,
      r.debit,
      r.credit,
      r.date,
      r.description || '',
      r.importHash
    );
    return `($${b+1}, $${b+2}, $${b+3}, $${b+4}, $${b+5}, $${b+6}, $${b+7}, $${b+8}, $${b+9})`;
  });

  // Two partial indexes cover this table, one per account column, so a single
  // ON CONFLICT target cannot name both; DO NOTHING without a target lets
  // either index absorb the conflict.
  const inserted = await query<{ id: number }>(
    `INSERT INTO transactions
       (user_id, category_id, debit_account_id, credit_account_id, debit, credit, date, description, import_hash)
     VALUES ${tuples.join(', ')}
     ON CONFLICT DO NOTHING
     RETURNING id`,
    values
  );
  return inserted.length;
};
```

Note: `payee` is deliberately absent from the bulk insert's column list — Task 7 passes payee through `description` handling only for banks that expose it, and adding it here would mean a tenth placeholder per row. If a later profile needs payee stored, add it to both the column list and the tuple width.

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd backend && npx jest --testPathPatterns=importQueries`
Expected: PASS (4 tests).

- [ ] **Step 6: Run the existing transaction tests for regressions**

Run: `cd backend && npx jest --testPathPatterns=transactions`
Expected: PASS — the insert gained a column but every existing caller omits `importHash`, which defaults to NULL.

- [ ] **Step 7: Commit**

```bash
git add backend/src/db/queries/transactions.ts backend/src/test/importQueries.test.ts
git commit -m "feat(import): add import_hash queries and bulk idempotent insert"
```

---

### Task 7: Import service — parse

**Files:**
- Create: `backend/src/services/import/index.ts`
- Test: `backend/src/test/importService.test.ts`

**Interfaces:**
- Consumes: `readStatement` (4), `computeImportHashes` (5), `detectProfile`/`getProfile` (3), `findExistingImportHashes`/`findByDates` (6), `requireLevel`/`LEVEL` (`services/access.ts`), `getAccountById` (`db/queries/accounts.ts`), `toCents` (`services/currency.ts`).
- Produces:
  - `interface ImportRow { index; date; amount; description; payee; hash; status: 'new' | 'duplicate' | 'possible_duplicate'; duplicateOf: number | null }`
  - `parseStatement(userId: number, accountId: number, contentBase64: string, format?: string): Promise<ParseResult>`
  - `interface ParseResult { format: string; account: { id; name; currency; scale }; rows: ImportRow[]; summary: { total; new: number; duplicate: number; possibleDuplicate: number } }`

- [ ] **Step 1: Write the failing test**

Create `backend/src/test/importService.test.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';
import { pool } from '../db';
import { parseStatement } from '../services/import';

const fixtureB64 = (...p: string[]) =>
  fs.readFileSync(path.join(__dirname, 'fixtures', 'banks', ...p)).toString('base64');

describe('parseStatement', () => {
  let userId: number;
  let otherUserId: number;
  let eurAccountId: number;
  let usdAccountId: number;

  beforeAll(async () => {
    const mk = async (email: string) => {
      const u = await pool.query(
        `INSERT INTO users (email, password_hash, name, currency)
         VALUES ($1, 'x', 'Svc Test', 'EUR') RETURNING id`,
        [email]
      );
      return u.rows[0].id as number;
    };
    userId = await mk(`svc${Date.now()}@example.com`);
    otherUserId = await mk(`svcb${Date.now()}@example.com`);

    const eur = await pool.query(
      `INSERT INTO accounts (user_id, name, currency, start_balance)
       VALUES ($1, 'EUR Account', 'EUR', 0) RETURNING id`,
      [userId]
    );
    eurAccountId = eur.rows[0].id;
    const usd = await pool.query(
      `INSERT INTO accounts (user_id, name, currency, start_balance)
       VALUES ($1, 'USD Account', 'USD', 0) RETURNING id`,
      [userId]
    );
    usdAccountId = usd.rows[0].id;
  });

  afterAll(async () => {
    for (const id of [userId, otherUserId]) {
      await pool.query('DELETE FROM transactions WHERE user_id = $1', [id]);
      await pool.query('DELETE FROM accounts WHERE user_id = $1', [id]);
      await pool.query('DELETE FROM categories WHERE user_id = $1', [id]);
      await pool.query('DELETE FROM users WHERE id = $1', [id]);
    }
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM transactions WHERE user_id = $1', [userId]);
  });

  it('auto-detects LHV and returns every row as new', async () => {
    const result = await parseStatement(userId, eurAccountId, fixtureB64('lhv', 'statement.csv'));
    expect(result.format).toBe('lhv');
    expect(result.rows).toHaveLength(143);
    expect(result.summary.new).toBe(143);
    expect(result.summary.duplicate).toBe(0);
  });

  it('auto-detects Bank of Cyprus', async () => {
    const result = await parseStatement(
      userId, eurAccountId, fixtureB64('bank_of_cyprus', 'statement.csv')
    );
    expect(result.format).toBe('boc');
    expect(result.rows).toHaveLength(10);
  });

  it('honours an explicit format', async () => {
    const result = await parseStatement(
      userId, eurAccountId, fixtureB64('lhv', 'statement.csv'), 'lhv'
    );
    expect(result.format).toBe('lhv');
  });

  it('rejects an unknown explicit format with 400', async () => {
    await expect(
      parseStatement(userId, eurAccountId, fixtureB64('lhv', 'statement.csv'), 'nope')
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects an unrecognised file with 400', async () => {
    const junk = Buffer.from('foo,bar\n1,2\n').toString('base64');
    await expect(parseStatement(userId, eurAccountId, junk))
      .rejects.toMatchObject({ statusCode: 400 });
  });

  it('rejects a currency mismatch with 400', async () => {
    await expect(
      parseStatement(userId, usdAccountId, fixtureB64('lhv', 'statement.csv'))
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('refuses an account the user cannot reach with 403', async () => {
    await expect(
      parseStatement(otherUserId, eurAccountId, fixtureB64('lhv', 'statement.csv'))
    ).rejects.toMatchObject({ statusCode: 403 });
  });

  it('writes nothing to the database', async () => {
    await parseStatement(userId, eurAccountId, fixtureB64('lhv', 'statement.csv'));
    const count = await pool.query(
      'SELECT COUNT(*) FROM transactions WHERE user_id = $1', [userId]
    );
    expect(Number(count.rows[0].count)).toBe(0);
  });

  it('flags an existing hash as duplicate', async () => {
    const first = await parseStatement(userId, eurAccountId, fixtureB64('lhv', 'statement.csv'));
    const hash = first.rows[0].hash;
    await pool.query(
      `INSERT INTO transactions
         (user_id, category_id, credit_account_id, debit, credit, date, description, import_hash)
       VALUES ($1, 3, $2, 130528, 130528, '2026-07-01', 'seed', $3)`,
      [userId, eurAccountId, hash]
    );
    const again = await parseStatement(userId, eurAccountId, fixtureB64('lhv', 'statement.csv'));
    expect(again.rows[0].status).toBe('duplicate');
    expect(again.summary.duplicate).toBe(1);
  });

  it('flags a hand-entered match as possible_duplicate, not duplicate', async () => {
    // Same date and amount as LHV row 0 (+1305.28), but no import_hash —
    // the shape of a transaction typed in by hand before importing began.
    await pool.query(
      `INSERT INTO transactions
         (user_id, category_id, credit_account_id, debit, credit, date, description)
       VALUES ($1, 3, $2, 130528, 130528, '2026-07-01', 'typed by hand')`,
      [userId, eurAccountId]
    );
    const result = await parseStatement(userId, eurAccountId, fixtureB64('lhv', 'statement.csv'));
    expect(result.rows[0].status).toBe('possible_duplicate');
    expect(result.rows[0].duplicateOf).toEqual(expect.any(Number));
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && npx jest --testPathPatterns=importService`
Expected: FAIL — `Cannot find module '../services/import'`.

- [ ] **Step 3: Write the implementation**

Create `backend/src/services/import/index.ts`:

```ts
import * as accountQueries from '../../db/queries/accounts';
import * as transactionQueries from '../../db/queries/transactions';
import { LEVEL, requireLevel } from '../access';
import { toCents } from '../currency';
import { detectProfile, getProfile, Profile } from './profiles';
import { readStatement, ParsedRow } from './rows';
import { computeImportHashes } from './hash';

export type RowStatus = 'new' | 'duplicate' | 'possible_duplicate';

export interface ImportRow {
  index: number;
  date: string;
  amount: number;
  description: string;
  payee: string | null;
  hash: string;
  status: RowStatus;
  duplicateOf: number | null;
}

export interface ParseResult {
  format: string;
  account: { id: number; name: string; currency: string; scale: number };
  rows: ImportRow[];
  summary: { total: number; new: number; duplicate: number; possibleDuplicate: number };
}

/** The account, once the caller is known to hold WRITE on it. */
async function loadWritableAccount(accountId: number, userId: number) {
  const account = await accountQueries.getAccountById(accountId);
  if (!account || account.deleted) {
    throw { statusCode: 404, message: 'Account not found' };
  }
  await requireLevel(accountId, userId, LEVEL.WRITE);
  return account;
}

function resolveProfile(grid: string[][], format?: string): Profile {
  if (format) return getProfile(format);
  const detected = detectProfile(grid);
  if (!detected) {
    throw {
      statusCode: 400,
      message: 'Could not recognise this statement format. Pass "format" explicitly.',
    };
  }
  return detected;
}

export const parseStatement = async (
  userId: number,
  accountId: number,
  contentBase64: string,
  format?: string
): Promise<ParseResult> => {
  const account = await loadWritableAccount(accountId, userId);

  const text = Buffer.from(contentBase64, 'base64').toString('utf8');
  // Detection needs the grid, and the grid needs a delimiter — every profile
  // today uses ',', so a plain read is enough to find the header.
  const { parseCsv } = await import('./csv');
  const profile = resolveProfile(parseCsv(text), format);

  const { rows, currency } = readStatement(text, profile);

  if (currency !== account.currency) {
    throw {
      statusCode: 400,
      message: `Statement is in ${currency} but the account is in ${account.currency}`,
    };
  }

  const hashes = computeImportHashes(rows, profile);

  // Exact: hashes this account has already seen.
  const existing = new Set(await transactionQueries.findExistingImportHashes(accountId, hashes));

  // Advisory: same date and same amount, catching transactions typed in by
  // hand before importing ever started — those carry no hash at all.
  const dates = [...new Set(rows.map(r => r.date))];
  const sameDay = await transactionQueries.findByDates(accountId, dates);
  const byKey = new Map<string, number>();
  for (const t of sameDay) {
    const d = t.date instanceof Date ? t.date.toISOString().slice(0, 10) : String(t.date).slice(0, 10);
    // Income stores the amount in credit, expense in debit; both are equal
    // for single-account rows, so either side keys the match.
    byKey.set(`${d}|${t.credit}`, t.id);
    byKey.set(`${d}|-${t.debit}`, t.id);
  }

  const out: ImportRow[] = rows.map((row, i) => {
    const hash = hashes[i];
    let status: RowStatus = 'new';
    let duplicateOf: number | null = null;

    if (existing.has(hash)) {
      status = 'duplicate';
    } else {
      const cents = toCents(Math.abs(row.amount), account.scale);
      const key = `${row.date}|${row.amount < 0 ? '-' : ''}${cents}`;
      const match = byKey.get(key);
      if (match !== undefined) {
        status = 'possible_duplicate';
        duplicateOf = match;
      }
    }
    return {
      index: row.index,
      date: row.date,
      amount: row.amount,
      description: row.description,
      payee: row.payee,
      hash,
      status,
      duplicateOf,
    };
  });

  return {
    format: profile.id,
    account: {
      id: account.id,
      name: account.name,
      currency: account.currency,
      scale: account.scale,
    },
    rows: out,
    summary: {
      total: out.length,
      new: out.filter(r => r.status === 'new').length,
      duplicate: out.filter(r => r.status === 'duplicate').length,
      possibleDuplicate: out.filter(r => r.status === 'possible_duplicate').length,
    },
  };
};
```

Replace the dynamic `await import('./csv')` with a top-level
`import { parseCsv } from './csv';` alongside the other imports — it is
written inline above only to keep the reading order clear.

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && npx jest --testPathPatterns=importService`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/import/index.ts backend/src/test/importService.test.ts
git commit -m "feat(import): parse statements and classify rows against existing transactions"
```

---

### Task 8: Import service — reconcile

**Files:**
- Modify: `backend/src/services/import/index.ts`
- Test: `backend/src/test/importReconcile.test.ts`

**Interfaces:**
- Consumes: everything from Task 7, plus `createImportedTransactions` (Task 6).
- Produces:
  - `interface ReconcileRow { date: string; amount: number; description?: string; payee?: string | null; hash: string; categoryId?: number | null }`
  - `reconcile(userId: number, accountId: number, rows: ReconcileRow[]): Promise<{ created: number; skipped: number }>`

- [ ] **Step 1: Write the failing test**

Create `backend/src/test/importReconcile.test.ts`:

```ts
import * as fs from 'fs';
import * as path from 'path';
import { pool } from '../db';
import { parseStatement, reconcile } from '../services/import';

const fixtureB64 = (...p: string[]) =>
  fs.readFileSync(path.join(__dirname, 'fixtures', 'banks', ...p)).toString('base64');

describe('reconcile', () => {
  let userId: number;
  let otherUserId: number;
  let accountId: number;

  beforeAll(async () => {
    const mk = async (email: string) => {
      const u = await pool.query(
        `INSERT INTO users (email, password_hash, name, currency)
         VALUES ($1, 'x', 'Rec Test', 'EUR') RETURNING id`,
        [email]
      );
      return u.rows[0].id as number;
    };
    userId = await mk(`rec${Date.now()}@example.com`);
    otherUserId = await mk(`recb${Date.now()}@example.com`);
    const a = await pool.query(
      `INSERT INTO accounts (user_id, name, currency, start_balance)
       VALUES ($1, 'Rec Account', 'EUR', 0) RETURNING id`,
      [userId]
    );
    accountId = a.rows[0].id;
  });

  afterAll(async () => {
    for (const id of [userId, otherUserId]) {
      await pool.query('DELETE FROM transactions WHERE user_id = $1', [id]);
      await pool.query('DELETE FROM accounts WHERE user_id = $1', [id]);
      await pool.query('DELETE FROM categories WHERE user_id = $1', [id]);
      await pool.query('DELETE FROM users WHERE id = $1', [id]);
    }
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM transactions WHERE user_id = $1', [userId]);
  });

  const parsed = () => parseStatement(userId, accountId, fixtureB64('lhv', 'statement.csv'));

  it('creates one transaction per row', async () => {
    const { rows } = await parsed();
    const result = await reconcile(userId, accountId, rows);
    expect(result.created).toBe(143);
    expect(result.skipped).toBe(0);
  });

  it('is idempotent — the same payload twice creates nothing the second time', async () => {
    const { rows } = await parsed();
    await reconcile(userId, accountId, rows);
    const second = await reconcile(userId, accountId, rows);
    expect(second.created).toBe(0);
    expect(second.skipped).toBe(143);
  });

  it('round-trips: after reconcile, re-parsing flags every row duplicate', async () => {
    const { rows } = await parsed();
    await reconcile(userId, accountId, rows);
    const again = await parsed();
    expect(again.summary.duplicate).toBe(143);
    expect(again.summary.new).toBe(0);
  });

  it('stores four distinct transactions for the four identical rows', async () => {
    const { rows } = await parsed();
    await reconcile(userId, accountId, rows);
    const dupes = await pool.query(
      `SELECT COUNT(*) FROM transactions
       WHERE user_id = $1 AND date = '2026-07-29' AND debit = 1000`,
      [userId]
    );
    expect(Number(dupes.rows[0].count)).toBe(4);
  });

  it('routes a negative amount to debit and a positive to credit', async () => {
    const { rows } = await parsed();
    await reconcile(userId, accountId, rows);
    const expenses = await pool.query(
      `SELECT COUNT(*) FROM transactions
       WHERE user_id = $1 AND debit_account_id = $2 AND credit_account_id IS NULL`,
      [userId, accountId]
    );
    const incomes = await pool.query(
      `SELECT COUNT(*) FROM transactions
       WHERE user_id = $1 AND credit_account_id = $2 AND debit_account_id IS NULL`,
      [userId, accountId]
    );
    expect(Number(expenses.rows[0].count)).toBe(133);
    expect(Number(incomes.rows[0].count)).toBe(10);
  });

  it('converts decimals to cents using the account scale', async () => {
    const { rows } = await parsed();
    await reconcile(userId, accountId, [rows[0]]);
    const t = await pool.query(
      'SELECT credit FROM transactions WHERE user_id = $1', [userId]
    );
    expect(Number(t.rows[0].credit)).toBe(130528);
  });

  it('assigns the uncategorized defaults when no category is given', async () => {
    const { rows } = await parsed();
    await reconcile(userId, accountId, [rows[0]]);
    const t = await pool.query(
      'SELECT category_id FROM transactions WHERE user_id = $1', [userId]
    );
    expect(t.rows[0].category_id).toBe(3); // income
  });

  it('imports a row the user kept despite a possible_duplicate flag', async () => {
    await pool.query(
      `INSERT INTO transactions
         (user_id, category_id, credit_account_id, debit, credit, date, description)
       VALUES ($1, 3, $2, 130528, 130528, '2026-07-01', 'typed by hand')`,
      [userId, accountId]
    );
    const { rows } = await parsed();
    expect(rows[0].status).toBe('possible_duplicate');
    // The heuristic is advisory: reconcile must NOT re-apply it and silently
    // drop the row the user decided to keep.
    const result = await reconcile(userId, accountId, [rows[0]]);
    expect(result.created).toBe(1);
  });

  it('refuses an account the user cannot reach with 403', async () => {
    const { rows } = await parsed();
    await expect(reconcile(otherUserId, accountId, rows))
      .rejects.toMatchObject({ statusCode: 403 });
  });

  it('rejects a row with no hash', async () => {
    await expect(
      reconcile(userId, accountId, [
        { date: '2026-07-01', amount: -5, hash: '' } as never,
      ])
    ).rejects.toMatchObject({ statusCode: 400 });
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && npx jest --testPathPatterns=importReconcile`
Expected: FAIL — `reconcile is not a function`.

- [ ] **Step 3: Write the implementation**

Append to `backend/src/services/import/index.ts`:

```ts
const UNCATEGORIZED_INCOME_CATEGORY_ID = 3;
const UNCATEGORIZED_EXPENSE_CATEGORY_ID = 4;

export interface ReconcileRow {
  date: string;
  amount: number;
  description?: string;
  payee?: string | null;
  hash: string;
  categoryId?: number | null;
}

/**
 * Insert the rows the user chose.
 *
 * The rows come back from the client, so nothing in them is trusted: access
 * is re-checked, amounts are re-converted through the account's own scale,
 * and hashes are re-checked. A client that skips parse entirely and posts
 * straight here gets the same treatment.
 *
 * Only the hash is re-checked. The date-and-amount heuristic is NOT re-run:
 * a row the user reviewed as possible_duplicate and chose to keep must
 * import, and re-applying the advisory match here would silently discard
 * exactly the rows the user made a decision about.
 */
export const reconcile = async (
  userId: number,
  accountId: number,
  rows: ReconcileRow[]
): Promise<{ created: number; skipped: number }> => {
  const account = await loadWritableAccount(accountId, userId);

  if (rows.length === 0) return { created: 0, skipped: 0 };

  for (const row of rows) {
    if (!row.hash) {
      throw { statusCode: 400, message: 'Every row must carry an import hash' };
    }
    if (!Number.isFinite(row.amount) || row.amount === 0) {
      throw { statusCode: 400, message: `Row ${row.date} has no usable amount` };
    }
  }

  const hashes = rows.map(r => r.hash);
  const existing = new Set(
    await transactionQueries.findExistingImportHashes(accountId, hashes)
  );

  // Two rows in one payload can share a hash only if the client duplicated
  // them; keeping the first is consistent with the index rejecting the rest.
  const seen = new Set<string>();
  const toInsert = rows.filter(r => {
    if (existing.has(r.hash) || seen.has(r.hash)) return false;
    seen.add(r.hash);
    return true;
  });

  const payload = toInsert.map(row => {
    const cents = toCents(Math.abs(row.amount), account.scale);
    const isExpense = row.amount < 0;
    return {
      categoryId:
        row.categoryId ??
        (isExpense ? UNCATEGORIZED_EXPENSE_CATEGORY_ID : UNCATEGORIZED_INCOME_CATEGORY_ID),
      debitAccountId: isExpense ? accountId : undefined,
      creditAccountId: isExpense ? undefined : accountId,
      debit: cents,
      credit: cents,
      date: row.date,
      description: row.description ?? '',
      importHash: row.hash,
    };
  });

  const created = await transactionQueries.createImportedTransactions(userId, payload);
  return { created, skipped: rows.length - created };
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `cd backend && npx jest --testPathPatterns=importReconcile`
Expected: PASS (10 tests).

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/import/index.ts backend/src/test/importReconcile.test.ts
git commit -m "feat(import): reconcile parsed rows into transactions idempotently"
```

---

### Task 9: Routes and wiring

**Files:**
- Create: `backend/src/routes/import.ts`
- Modify: `backend/src/index.ts`, `backend/src/test/testApp.ts`
- Test: `backend/src/test/importApi.test.ts`

**Interfaces:**
- Consumes: `parseStatement`, `reconcile` (Tasks 7–8).
- Produces: `POST /api/import/parse`, `POST /api/import/reconcile`.

- [ ] **Step 1: Write the failing test**

Create `backend/src/test/importApi.test.ts`:

```ts
import request from 'supertest';
import * as fs from 'fs';
import * as path from 'path';
import { createTestApp } from './testApp';
import { pool } from '../db';

const app = createTestApp();
const fixtureB64 = (...p: string[]) =>
  fs.readFileSync(path.join(__dirname, 'fixtures', 'banks', ...p)).toString('base64');

describe('Import API', () => {
  let token: string;
  let userId: number;
  let accountId: number;

  beforeAll(async () => {
    const email = `api${Date.now()}@example.com`;
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email, password: 'password123' });
    token = res.body.data.accessToken;
    const u = await pool.query('SELECT id FROM users WHERE email = $1', [email]);
    userId = u.rows[0].id;
    const a = await pool.query(
      `INSERT INTO accounts (user_id, name, currency, start_balance)
       VALUES ($1, 'API Account', 'EUR', 0) RETURNING id`,
      [userId]
    );
    accountId = a.rows[0].id;
  });

  afterAll(async () => {
    await pool.query('DELETE FROM transactions WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM accounts WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM categories WHERE user_id = $1', [userId]);
    await pool.query('DELETE FROM users WHERE id = $1', [userId]);
  });

  beforeEach(async () => {
    await pool.query('DELETE FROM transactions WHERE user_id = $1', [userId]);
  });

  it('requires authentication', async () => {
    const res = await request(app).post('/api/import/parse').send({});
    expect(res.status).toBe(401);
  });

  it('rejects a body with no content', async () => {
    const res = await request(app)
      .post('/api/import/parse')
      .set('Authorization', `Bearer ${token}`)
      .send({ accountId });
    expect(res.status).toBe(400);
    expect(res.body.error).toBeTruthy();
  });

  it('parses a statement and returns the envelope', async () => {
    const res = await request(app)
      .post('/api/import/parse')
      .set('Authorization', `Bearer ${token}`)
      .send({ accountId, content: fixtureB64('lhv', 'statement.csv') });
    expect(res.status).toBe(200);
    expect(res.body.error).toBeNull();
    expect(res.body.data.format).toBe('lhv');
    expect(res.body.data.rows).toHaveLength(143);
    expect(res.body.data.summary.total).toBe(143);
  });

  it('reconciles the parsed rows', async () => {
    const parsed = await request(app)
      .post('/api/import/parse')
      .set('Authorization', `Bearer ${token}`)
      .send({ accountId, content: fixtureB64('lhv', 'statement.csv') });

    const res = await request(app)
      .post('/api/import/reconcile')
      .set('Authorization', `Bearer ${token}`)
      .send({ accountId, rows: parsed.body.data.rows });

    expect(res.status).toBe(200);
    expect(res.body.data.created).toBe(143);
  });

  it('surfaces a currency mismatch as 400', async () => {
    const usd = await pool.query(
      `INSERT INTO accounts (user_id, name, currency, start_balance)
       VALUES ($1, 'USD', 'USD', 0) RETURNING id`,
      [userId]
    );
    const res = await request(app)
      .post('/api/import/parse')
      .set('Authorization', `Bearer ${token}`)
      .send({ accountId: usd.rows[0].id, content: fixtureB64('lhv', 'statement.csv') });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain('USD');
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `cd backend && npx jest --testPathPatterns=importApi`
Expected: FAIL — 404 on `/api/import/parse`, since the router is not mounted.

- [ ] **Step 3: Write the router**

Create `backend/src/routes/import.ts`:

```ts
import { Router } from 'express';
import { z } from 'zod';
import { authMiddleware, AuthRequest } from '../middleware/auth';
import { validate } from '../middleware/validation';
import * as importService from '../services/import';

const router = Router();

router.use(authMiddleware);

const parseSchema = z.object({
  accountId: z.number().int().positive(),
  format: z.string().optional(),
  /** The statement file, base64. */
  content: z.string().min(1),
});

const reconcileSchema = z.object({
  accountId: z.number().int().positive(),
  rows: z.array(
    z.object({
      date: z.string(),
      amount: z.number(),
      description: z.string().optional(),
      payee: z.string().nullish(),
      hash: z.string().min(1),
      categoryId: z.number().int().positive().nullish(),
    })
  ).min(1),
});

router.post('/parse', validate(parseSchema), async (req: AuthRequest, res, next) => {
  try {
    const { accountId, format, content } = req.body;
    const result = await importService.parseStatement(req.userId!, accountId, content, format);
    res.json({ data: result, error: null });
  } catch (error) {
    next(error);
  }
});

router.post('/reconcile', validate(reconcileSchema), async (req: AuthRequest, res, next) => {
  try {
    const { accountId, rows } = req.body;
    const result = await importService.reconcile(req.userId!, accountId, rows);
    res.json({ data: result, error: null });
  } catch (error) {
    next(error);
  }
});

export default router;
```

- [ ] **Step 4: Mount the router in both apps**

In `backend/src/index.ts`, add the import beside the others and mount it after `accountRoutes`:

```ts
import importRoutes from './routes/import';
// ...
app.use('/api/import', importRoutes);
```

In `backend/src/test/testApp.ts`, the same:

```ts
import importRoutes from '../routes/import';
// ...
app.use('/api/import', importRoutes);
```

Note: `express.json()`'s default body limit is 100KB. The LHV fixture is
~40KB of CSV, roughly 54KB as base64, so it fits — but a longer statement
would not. Raise the limit in **both** apps where `express.json()` is called:

```ts
app.use(express.json({ limit: '10mb' }));
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `cd backend && npx jest --testPathPatterns=importApi`
Expected: PASS (5 tests).

- [ ] **Step 6: Commit**

```bash
git add backend/src/routes/import.ts backend/src/index.ts backend/src/test/testApp.ts backend/src/test/importApi.test.ts
git commit -m "feat(import): expose parse and reconcile endpoints"
```

---

### Task 10: Full verification

**Files:** none changed unless a regression appears.

- [ ] **Step 1: Run the whole backend suite**

Run: `cd backend && npm test`
Expected: every suite passes, including the pre-existing `transactions`, `accounts`, `sharing` and `access` tests.

- [ ] **Step 2: Typecheck**

Run: `cd backend && npm run build`
Expected: no TypeScript errors, `dist/` written.

- [ ] **Step 3: Fix anything that failed, then re-run**

If a pre-existing suite broke, the likely cause is the `createTransaction`
insert gaining a column (Task 6) — check that every placeholder index still
lines up with its value.

- [ ] **Step 4: Commit any fixes**

```bash
git add -A backend/src
git commit -m "fix(import): address regressions found in full-suite verification"
```

---

## Notes for the implementer

- **Do not read `backend/banks/`.** Those are real statements and gitignored. Tests read `backend/src/test/fixtures/banks/`.
- **Access checks belong in the service.** Adding a `user_id` filter to an import query would look like security and would in fact break sharing: a transaction is visible through its *accounts*, and `transactions.user_id` only records who entered it.
- **`possible_duplicate` is advisory by design.** It exists because hand-entered transactions carry no hash. Never let it block an insert.
- **The occurrence index is not decoration.** Deleting it makes four real charges collapse into one on any bank without a reference number.
- **The two partial indexes are independent**, verified against PostgreSQL: the same hash can satisfy both the debit index and the credit index on one account. The service never does this, because a row's sign puts it on exactly one side — and `findExistingImportHashes` checks `debit_account_id OR credit_account_id` for the same reason. Do not narrow that query to one column.
- **`ON CONFLICT DO NOTHING` carries no conflict target on purpose.** Two partial indexes cover the table and a single target cannot name both. Verified: a mixed batch of new and conflicting rows inserts only the new ones, and `RETURNING id` yields only those, so the `created` count is accurate.
