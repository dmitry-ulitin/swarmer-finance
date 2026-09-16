# Account Type and Optional Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each account a `type` (cash/bank/crypto) and a JSONB `settings` object holding that type's optional attributes, validated per-type at the API boundary.

**Architecture:** A `type` TEXT column with a CHECK constraint plus a `settings` JSONB column. A Zod discriminated union on `type` validates settings per type, so adding a field to an existing type is a code change and adding a type is a one-line migration. The Angular form holds controls for every type in one FormGroup and shows the relevant ones with `@if`.

**Tech Stack:** Node 26 + Express 5 + PostgreSQL (raw SQL, no ORM), Zod 4.4.3, Jest + supertest; Angular 22 standalone + Taiga UI 5.24, Vitest + jsdom.

**Spec:** `docs/superpowers/specs/2026-09-16-account-type-settings-design.md`

## Global Constraints

- Account types in this iteration: exactly `cash`, `bank`, `crypto`. Nothing else.
- Settings fields: `cash` → none; `bank` → `accountNumber?: string` (max 64); `crypto` → `address?: string` (max 128), `blockchain?: string` (max 64). All optional.
- Statement format for CSV import is **out of scope** — do not add it.
- Settings keys are camelCase inside the JSONB document; table columns stay snake_case.
- `settings` is `NOT NULL DEFAULT '{}'` — code never handles a NULL settings.
- `updateAccount` writes `settings` **whole, never merged** — changing type must drop the old type's fields.
- Use `z.strictObject(...)`, not `z.object(...).strict()` (deprecated in Zod 4).
- **Never build the account schemas with `.and()`** — see Task 2, this silently disables settings validation.
- Angular: standalone components, `ChangeDetectionStrategy.OnPush`, `input()`/`output()`, `computed()`, native `@if`/`@for`, no `ngClass`/`ngStyle`.
- Backend tests: `cd backend && npx jest --testPathPattern=accounts`. Frontend tests: `cd frontend && npm test` (not bare `npx vitest run`).
- Commit messages end with: `Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>`

## File Structure

**Backend**
- Create `backend/src/db/migrations/008_add_accounts_type_settings.sql` — schema change.
- Modify `backend/src/types/index.ts` — `AccountType`, `Account.type`, `Account.settings`.
- Modify `backend/src/db/queries/accounts.ts` — INSERT/UPDATE carry the new columns.
- Modify `backend/src/services/accounts.ts` — pass-through of type/settings.
- Modify `backend/src/routes/accounts.ts` — the discriminated-union schemas.
- Modify `backend/src/test/accounts.test.ts` — new describe block.

**Frontend**
- Modify `frontend/src/app/models/account.ts` — the mirrored union type.
- Modify `frontend/src/app/core/api.service.ts` — widen create/update payload types.
- Modify `frontend/src/app/core/accounts.state.ts` — widen create/update signatures.
- Modify `frontend/src/app/core/accounts.state.spec.ts` — fixture gains type/settings.
- Modify `frontend/src/app/features/accounts/account-form/account-form.ts` + `.html` — type selector and per-type fields.
- Create `frontend/src/app/features/accounts/account-form/account-form.spec.ts` — payload-assembly tests.

Tasks 1–4 are backend and must run in order. Task 5 (model + state) unblocks Tasks 6–7 (form). Task 5 depends on Task 4 only for the API contract being real, not for compilation.

---

### Task 1: Database migration

**Files:**
- Create: `backend/src/db/migrations/008_add_accounts_type_settings.sql`
- Modify: `backend/src/types/index.ts:23-34` (the `Account` interface)

**Interfaces:**
- Consumes: nothing.
- Produces: `accounts.type TEXT NOT NULL DEFAULT 'cash'`, `accounts.settings JSONB NOT NULL DEFAULT '{}'`, constraint `chk_accounts_type`. Exported type `AccountType = 'cash' | 'bank' | 'crypto'` and fields `Account.type: AccountType`, `Account.settings: Record<string, unknown>`.

- [ ] **Step 1: Write the migration**

Create `backend/src/db/migrations/008_add_accounts_type_settings.sql`:

```sql
ALTER TABLE accounts
  ADD COLUMN type TEXT NOT NULL DEFAULT 'cash',
  ADD COLUMN settings JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE accounts
  ADD CONSTRAINT chk_accounts_type
  CHECK (type IN ('cash', 'bank', 'crypto'));
```

The `DEFAULT 'cash'` backfills every existing row, so no separate UPDATE is needed.

- [ ] **Step 2: Run the migration**

```bash
cd backend && npm run migrate
```

Expected: `Running migration: 008_add_accounts_type_settings.sql` then `Completed:`. The runner wraps everything in a transaction and records the filename in `schema_migrations`, so re-running is a no-op.

- [ ] **Step 3: Verify the schema and the backfill**

```bash
cd backend && npx tsx -e "import {pool} from './src/db'; (async()=>{ \
  const c=await pool.query(\"SELECT column_name,data_type,is_nullable,column_default FROM information_schema.columns WHERE table_name='accounts' AND column_name IN ('type','settings')\"); \
  console.log(c.rows); \
  const k=await pool.query(\"SELECT conname FROM pg_constraint WHERE conname='chk_accounts_type'\"); \
  console.log(k.rows); \
  const b=await pool.query('SELECT COUNT(*)::int AS n FROM accounts WHERE type IS NULL OR settings IS NULL'); \
  console.log('null rows:', b.rows[0].n); \
  await pool.end(); })()"
```

Expected: both columns present and `is_nullable: 'NO'`; `chk_accounts_type` listed; `null rows: 0`.

- [ ] **Step 4: Add the types**

In `backend/src/types/index.ts`, above the `Account` interface:

```ts
export type AccountType = 'cash' | 'bank' | 'crypto';
```

and inside `Account`, after `currency: string;`:

```ts
  type: AccountType;
  settings: Record<string, unknown>;
```

- [ ] **Step 5: Verify it compiles**

```bash
cd backend && npx tsc --noEmit
```

Expected: no errors. (`Account` rows come straight from `SELECT *`, so nothing else needs changing yet.)

- [ ] **Step 6: Commit**

```bash
git add backend/src/db/migrations/008_add_accounts_type_settings.sql backend/src/types/index.ts
git commit -m "$(cat <<'EOF'
feat(accounts): add type and settings columns

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 2: Request validation schemas

**Files:**
- Modify: `backend/src/routes/accounts.ts:16-31` (schemas), `:41-49` (POST handler), `:51-59` (PUT handler)
- Test: `backend/src/test/accounts.test.ts`

**Interfaces:**
- Consumes: `AccountType` from Task 1.
- Produces: `createAccountSchema` and `updateAccountSchema` as discriminated unions. After `validate()`, `req.body` has `type: AccountType` and `settings: object` always present (Zod fills the default).

**Why the base fields are spread and not intersected:** `.and()` builds a `ZodIntersection`, which parses each side against the input independently and merges the results. The strict settings object then never sees the conflict, and `{ type: 'cash', settings: { accountNumber: '1' } }` is **accepted**. This was verified against this repo's Zod 4.4.3: with `.and()` both the unknown-key case and the wrong-type-key case pass; with the spread below, both are rejected. Using `.and()` here would silently disable the validation this whole feature exists for.

- [ ] **Step 1: Write the failing tests**

Append to `backend/src/test/accounts.test.ts`, inside the outer `describe('Accounts API — balance field', ...)` block, just before its closing `});` (so it reuses `token` and the `testUserId` cleanup):

```ts
  describe('Account type and settings', () => {
    it('defaults to cash with empty settings when type is omitted', async () => {
      const res = await request(app)
        .post('/api/accounts')
        .set({ Authorization: `Bearer ${token}` })
        .send({ name: 'No Type', currency: 'USD', startBalance: 0 });

      expect(res.status).toBe(200);
      expect(res.body.data.type).toBe('cash');
      expect(res.body.data.settings).toEqual({});
    });

    it('round-trips bank settings', async () => {
      const res = await request(app)
        .post('/api/accounts')
        .set({ Authorization: `Bearer ${token}` })
        .send({
          name: 'Checking', currency: 'USD', startBalance: 0,
          type: 'bank', settings: { accountNumber: 'DE89370400440532013000' },
        });

      expect(res.status).toBe(200);
      expect(res.body.data.type).toBe('bank');
      expect(res.body.data.settings).toEqual({ accountNumber: 'DE89370400440532013000' });
    });

    it('round-trips crypto settings', async () => {
      const res = await request(app)
        .post('/api/accounts')
        .set({ Authorization: `Bearer ${token}` })
        .send({
          name: 'Wallet', currency: 'BTC', startBalance: 0,
          type: 'crypto', settings: { address: 'bc1qxy2k', blockchain: 'bitcoin' },
        });

      expect(res.status).toBe(200);
      expect(res.body.data.settings).toEqual({ address: 'bc1qxy2k', blockchain: 'bitcoin' });
    });

    it('rejects a settings key belonging to another type', async () => {
      const res = await request(app)
        .post('/api/accounts')
        .set({ Authorization: `Bearer ${token}` })
        .send({
          name: 'Wrong', currency: 'USD', startBalance: 0,
          type: 'bank', settings: { address: 'bc1qxy2k' },
        });

      expect(res.status).toBe(400);
    });

    it('rejects an unknown settings key', async () => {
      const res = await request(app)
        .post('/api/accounts')
        .set({ Authorization: `Bearer ${token}` })
        .send({
          name: 'Typo', currency: 'USD', startBalance: 0,
          type: 'bank', settings: { acountNumber: '123' },
        });

      expect(res.status).toBe(400);
    });

    it('rejects an unknown account type', async () => {
      const res = await request(app)
        .post('/api/accounts')
        .set({ Authorization: `Bearer ${token}` })
        .send({ name: 'Debt', currency: 'USD', startBalance: 0, type: 'debt' });

      expect(res.status).toBe(400);
    });

    it('replaces settings rather than merging them when the type changes', async () => {
      const created = await request(app)
        .post('/api/accounts')
        .set({ Authorization: `Bearer ${token}` })
        .send({
          name: 'Switcher', currency: 'USD', startBalance: 0,
          type: 'bank', settings: { accountNumber: '111' },
        });
      const id = created.body.data.id;

      const updated = await request(app)
        .put(`/api/accounts/${id}`)
        .set({ Authorization: `Bearer ${token}` })
        .send({
          name: 'Switcher', currency: 'USD', startBalance: 0,
          type: 'crypto', settings: { address: '0xabc' },
        });

      expect(updated.status).toBe(200);
      expect(updated.body.data.type).toBe('crypto');
      expect(updated.body.data.settings).toEqual({ address: '0xabc' });
      expect(updated.body.data.settings.accountNumber).toBeUndefined();
    });

    it('rejects a PUT that omits type', async () => {
      const created = await request(app)
        .post('/api/accounts')
        .set({ Authorization: `Bearer ${token}` })
        .send({ name: 'Renamable', currency: 'USD', startBalance: 0, type: 'cash' });
      const id = created.body.data.id;

      const res = await request(app)
        .put(`/api/accounts/${id}`)
        .set({ Authorization: `Bearer ${token}` })
        .send({ name: 'Renamed' });

      expect(res.status).toBe(400);
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

```bash
cd backend && npx jest --testPathPattern=accounts -t "Account type and settings"
```

Expected: FAIL. The first three fail because `res.body.data.type` is `undefined`; the rejection tests fail because the current schema ignores unknown keys and returns 200.

- [ ] **Step 3: Replace the schemas**

In `backend/src/routes/accounts.ts`, replace the `createAccountSchema` / `updateAccountSchema` block (leave `currencySchema` and its comment untouched) with:

```ts
const settingsByType = {
  cash: z.strictObject({}).default({}),
  bank: z.strictObject({
    accountNumber: z.string().max(64).optional(),
  }).default({}),
  crypto: z.strictObject({
    address: z.string().max(128).optional(),
    blockchain: z.string().max(64).optional(),
  }).default({}),
};

// Base fields are spread into each union member rather than combined with
// `.and()`: a ZodIntersection parses both sides independently and merges
// them, so the strict settings object never sees a cross-type key and
// `{ type: 'cash', settings: { accountNumber } }` would be accepted.
const createBase = {
  name: z.string().min(1).max(255),
  currency: currencySchema,
  startBalance: z.number().default(0),
  scale: z.number().optional().default(2),
};

const createAccountSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...createBase, type: z.literal('cash'), settings: settingsByType.cash }),
  z.strictObject({ ...createBase, type: z.literal('bank'), settings: settingsByType.bank }),
  z.strictObject({ ...createBase, type: z.literal('crypto'), settings: settingsByType.crypto }),
]);

// A discriminated union cannot be `.partial()` — the discriminant must be
// present — so PUT requires `type` on every request. The account form always
// submits its full value, so no caller is affected.
const updateBase = {
  name: z.string().min(1).max(255).optional(),
  currency: currencySchema.optional(),
  startBalance: z.number().optional(),
  scale: z.number().optional(),
};

const updateAccountSchema = z.discriminatedUnion('type', [
  z.strictObject({ ...updateBase, type: z.literal('cash'), settings: settingsByType.cash }),
  z.strictObject({ ...updateBase, type: z.literal('bank'), settings: settingsByType.bank }),
  z.strictObject({ ...updateBase, type: z.literal('crypto'), settings: settingsByType.crypto }),
]);
```

- [ ] **Step 4: Thread the new fields through the handlers**

In the POST handler, change the destructuring and call:

```ts
    const { name, currency, startBalance, scale, type, settings } = req.body;
    const account = await accountService.createAccount(req.userId!, name, currency, startBalance, scale, type, settings);
```

The PUT handler already forwards `req.body` wholesale — leave it as is.

- [ ] **Step 5: Run the tests**

```bash
cd backend && npx jest --testPathPattern=accounts -t "Account type and settings"
```

Expected: the four rejection tests (`400`) PASS. The round-trip tests still FAIL — the service and queries do not persist the columns yet; that is Task 3. Do not commit yet.

---

### Task 3: Persist type and settings

**Files:**
- Modify: `backend/src/db/queries/accounts.ts:19-51` (`createAccount`, `updateAccount`)
- Modify: `backend/src/services/accounts.ts:56-88` (`createAccount`, `updateAccount`)
- Test: `backend/src/test/accounts.test.ts` (the tests from Task 2)

**Interfaces:**
- Consumes: `AccountType` (Task 1); `req.body.type` / `req.body.settings` (Task 2).
- Produces:
  - `accountQueries.createAccount(userId: number, name: string, currency: string, startBalance: number, scale: number, type: AccountType, settings: Record<string, unknown>): Promise<Account>`
  - `accountQueries.updateAccount(id: number, userId: number, data: { name?, currency?, startBalance?, scale?, type: AccountType, settings: Record<string, unknown> }): Promise<Account | null>`
  - `accountService.createAccount(userId, name, currency, startBalance, scale?, type?, settings?)` — `type` defaults to `'cash'`, `settings` to `{}`.

- [ ] **Step 1: Update the queries**

In `backend/src/db/queries/accounts.ts`, replace `createAccount`:

```ts
export const createAccount = async (
  userId: number,
  name: string,
  currency: string,
  startBalance: number,
  scale: number,
  type: AccountType,
  settings: Record<string, unknown>
): Promise<Account> => {
  const result = await query<Account>(
    `INSERT INTO accounts (user_id, name, currency, start_balance, scale, type, settings)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING *`,
    [userId, name, currency, startBalance, scale, type, JSON.stringify(settings)]
  );
  return result[0];
};
```

and `updateAccount`:

```ts
export const updateAccount = async (
  id: number,
  userId: number,
  data: {
    name?: string;
    currency?: string;
    startBalance?: number;
    scale?: number;
    type: AccountType;
    settings: Record<string, unknown>;
  }
): Promise<Account | null> => {
  // `type` and `settings` are written unconditionally, not COALESCEd:
  // changing an account's type must drop the previous type's fields.
  const result = await query<Account>(
    `UPDATE accounts
     SET name = COALESCE($1, name),
         currency = COALESCE($2, currency),
         start_balance = COALESCE($3, start_balance),
         scale = COALESCE($4, scale),
         type = $5,
         settings = $6
     WHERE id = $7 AND user_id = $8 AND deleted = false RETURNING *`,
    [
      data.name ?? null,
      data.currency ?? null,
      data.startBalance ?? null,
      data.scale ?? null,
      data.type,
      JSON.stringify(data.settings),
      id,
      userId,
    ]
  );
  return result[0] || null;
};
```

Update the import at the top of the file to `import { Account, AccountType } from '../../types';`.

`JSON.stringify` is required: `node-postgres` would otherwise send a JS object as a string like `[object Object]` for a JSONB parameter.

- [ ] **Step 2: Update the service**

In `backend/src/services/accounts.ts`, change `createAccount`'s signature and its query call:

```ts
export const createAccount = async (
  userId: number,
  name: string,
  currency: string,
  startBalance: number,
  scale = 2,
  type: AccountType = 'cash',
  settings: Record<string, unknown> = {}
) => {
  const user = await getUserOrThrow(userId);
  const account = await accountQueries.createAccount(userId, name, currency, toCents(startBalance, scale), scale, type, settings);
  const [converted] = await withConvertedBalances(user, [{ ...account, balance: Number(account.start_balance) }]);
  return toDecimalDTO(converted, user.currency_scale);
};
```

and widen `updateAccount`'s `data` parameter to include the two required fields:

```ts
export const updateAccount = async (
  id: number,
  userId: number,
  data: {
    name?: string;
    currency?: string;
    startBalance?: number;
    scale?: number;
    type: AccountType;
    settings: Record<string, unknown>;
  }
) => {
```

Its body already spreads `data` into the query call, so no further change is needed there.

Update the import to `import { Account, AccountType, User } from '../types';`.

- [ ] **Step 3: Run the tests**

```bash
cd backend && npx jest --testPathPattern=accounts
```

Expected: PASS, all of them — the eight new tests plus every pre-existing accounts test.

- [ ] **Step 4: Verify the whole backend suite and the compile**

```bash
cd backend && npx tsc --noEmit && npm test
```

Expected: no type errors, all suites pass.

- [ ] **Step 5: Commit**

```bash
git add backend/src/routes/accounts.ts backend/src/db/queries/accounts.ts backend/src/services/accounts.ts backend/src/test/accounts.test.ts
git commit -m "$(cat <<'EOF'
feat(accounts): validate and persist per-type account settings

Settings are validated by a Zod discriminated union on account type.
Base fields are spread into each union member rather than intersected
with .and(), which would merge independently-parsed halves and let a
cross-type settings key through.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 4: Manual API verification

**Files:** none — this task only exercises the running server.

**Interfaces:**
- Consumes: the endpoints from Tasks 2–3.
- Produces: confidence that the migration, validation and persistence agree outside the test harness.

- [ ] **Step 1: Start the dev server**

```bash
cd backend && npm run dev
```

Leave it running; use a second terminal for the next step.

- [ ] **Step 2: Exercise the endpoint end to end**

```bash
EMAIL="plan$(date +%s)@example.com"
TOKEN=$(curl -s -X POST localhost:3000/api/auth/register \
  -H 'Content-Type: application/json' \
  -d "{\"email\":\"$EMAIL\",\"password\":\"password123\"}" | sed -E 's/.*"accessToken":"([^"]+)".*/\1/')

echo "--- create crypto ---"
curl -s -X POST localhost:3000/api/accounts -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Ledger","currency":"BTC","startBalance":0,"type":"crypto","settings":{"address":"bc1qxy2k","blockchain":"bitcoin"}}'
echo; echo "--- reject cross-type key (expect error) ---"
curl -s -X POST localhost:3000/api/accounts -H "Authorization: Bearer $TOKEN" \
  -H 'Content-Type: application/json' \
  -d '{"name":"Bad","currency":"USD","startBalance":0,"type":"cash","settings":{"address":"x"}}'
echo; echo "--- list ---"
curl -s localhost:3000/api/accounts -H "Authorization: Bearer $TOKEN"
echo
```

Expected: the create returns `"type":"crypto"` with both settings keys; the second call returns a 400-shaped `{"data":null,"error":"settings: Unrecognized key: \"address\""}`; the list shows the account with its settings intact.

- [ ] **Step 3: Stop the server**

Ctrl-C the `npm run dev` terminal. Nothing to commit — this task changes no files.

---

### Task 5: Frontend model and state

**Files:**
- Modify: `frontend/src/app/models/account.ts` (whole file)
- Modify: `frontend/src/app/core/api.service.ts:52-58` (`createAccount`, `updateAccount`)
- Modify: `frontend/src/app/core/accounts.state.ts:159-165` (`create`, `update`)
- Test: `frontend/src/app/core/accounts.state.spec.ts:5-7` (`makeAccount`)

**Interfaces:**
- Consumes: the API contract from Tasks 2–3.
- Produces:
  - `AccountType = 'cash' | 'bank' | 'crypto'`
  - `AccountSettings` — `{ cash: Record<string, never>; bank: { accountNumber?: string }; crypto: { address?: string; blockchain?: string } }`
  - `Account` — a discriminated union over `type` carrying the matching `settings`
  - `AccountPayload = { name: string; currency: string; startBalance: number } & { [T in AccountType]: { type: T; settings: AccountSettings[T] } }[AccountType]` — what Task 6's form submits
  - `AccountsState.create(data: AccountPayload)`, `AccountsState.update(id: number, data: AccountPayload)`

- [ ] **Step 1: Write the failing test**

In `frontend/src/app/core/accounts.state.spec.ts`, replace `makeAccount` with a version carrying the new fields, and add a test below it that a typed account survives tree building:

```ts
function makeAccount(id: number, name: string): Account {
  return {
    id, user_id: 1, name, currency: 'USD', scale: 2, balance: 0, user_balance: 0,
    start_balance: 0, deleted: false, created_at: '',
    type: 'cash', settings: {},
  };
}

function makeCryptoAccount(id: number, name: string): Account {
  return {
    id, user_id: 1, name, currency: 'BTC', scale: 8, balance: 0, user_balance: 0,
    start_balance: 0, deleted: false, created_at: '',
    type: 'crypto', settings: { address: 'bc1qxy2k', blockchain: 'bitcoin' },
  };
}

describe('account type in the tree', () => {
  it('carries type and settings through to the leaf account', () => {
    const tree = buildAccountTree([makeCryptoAccount(1, 'Crypto/Ledger')]);
    expect(tree[0]).toMatchObject({
      kind: 'account',
      account: { type: 'crypto', settings: { blockchain: 'bitcoin' } },
    });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd frontend && npm test
```

Expected: FAIL — a TypeScript error that `type` and `settings` do not exist on `Account`.

- [ ] **Step 3: Update the model**

Replace the contents of `frontend/src/app/models/account.ts`:

```ts
export type AccountType = 'cash' | 'bank' | 'crypto';

export interface AccountSettings {
  cash: Record<string, never>;
  bank: { accountNumber?: string };
  crypto: { address?: string; blockchain?: string };
}

interface AccountBase {
  id: number;
  user_id: number;
  name: string;
  currency: string;
  scale: number;
  start_balance: number;
  balance: number;
  user_balance: number | null;
  deleted: boolean;
  created_at: string;
}

// A union over type, so `@if (account.type === 'crypto')` narrows
// `account.settings` to the crypto shape in templates and code.
export type Account = {
  [T in AccountType]: AccountBase & { type: T; settings: AccountSettings[T] };
}[AccountType];

// What the account form submits. `type` and `settings` always travel
// together, and the backend requires `type` on PUT as well as POST.
export type AccountPayload = {
  name: string;
  currency: string;
  startBalance: number;
} & {
  [T in AccountType]: { type: T; settings: AccountSettings[T] };
}[AccountType];
```

- [ ] **Step 4: Widen the API and state signatures**

In `frontend/src/app/core/api.service.ts`, import the payload type by changing the account import to `import { Account, AccountPayload } from '../models/account';` and replace the two methods:

```ts
  createAccount(data: AccountPayload): Observable<ApiResponse<Account>> {
    return this.http.post<ApiResponse<Account>>('/api/accounts', data);
  }

  updateAccount(id: number, data: AccountPayload): Observable<ApiResponse<Account>> {
    return this.http.put<ApiResponse<Account>>(`/api/accounts/${id}`, data);
  }
```

In `frontend/src/app/core/accounts.state.ts`, change the import to `import { Account, AccountPayload } from '../models/account';` and replace the two methods:

```ts
  create(data: AccountPayload) {
    return this.api.createAccount(data).pipe(tap(() => this.reload()));
  }

  update(id: number, data: AccountPayload) {
    return this.api.updateAccount(id, data).pipe(tap(() => this.reload()));
  }
```

- [ ] **Step 5: Run the tests**

```bash
cd frontend && npm test
```

Expected: the new test passes and the existing `accounts.state.spec.ts` tests still pass. `account-form.ts` now fails to compile because its `create`/`update` calls lack `type`/`settings` — that is Task 6. If the runner reports that error, proceed; do not patch the form here.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/app/models/account.ts frontend/src/app/core/api.service.ts frontend/src/app/core/accounts.state.ts frontend/src/app/core/accounts.state.spec.ts
git commit -m "$(cat <<'EOF'
feat(accounts): model account type and settings on the frontend

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 6: Account form — type selector and per-type fields

**Files:**
- Modify: `frontend/src/app/features/accounts/account-form/account-form.ts` (whole file)
- Modify: `frontend/src/app/features/accounts/account-form/account-form.html` (whole file)
- Create: `frontend/src/app/features/accounts/account-form/account-form.spec.ts`

**Interfaces:**
- Consumes: `Account`, `AccountType`, `AccountSettings`, `AccountPayload` (Task 5); `AccountsState.create` / `.update` (Task 5).
- Produces: `AccountForm.buildPayload(): AccountPayload` — an exported method the spec drives directly, assembling the payload from the form value and dropping blank optional fields.

**Note on the dialog context:** `AccountDialogService.openCreate` passes `{ currency }` — a partial, not a full `Account`. The existing code reads `this.context.data?.name ?? ''` and so tolerates it. Keep that shape: type the context data as `Partial<Account>` so `context.data?.type` and `context.data?.settings` are safe to read on create.

- [ ] **Step 1: Write the failing test**

Create `frontend/src/app/features/accounts/account-form/account-form.spec.ts`:

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { provideZonelessChangeDetection } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { POLYMORPHEUS_CONTEXT } from '@taiga-ui/polymorpheus';
import { AccountForm } from './account-form';
import type { Account } from '../../../models/account';

function createForm(data: Partial<Account> | null) {
  TestBed.configureTestingModule({
    providers: [
      provideZonelessChangeDetection(),
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: POLYMORPHEUS_CONTEXT, useValue: { data, completeWith: () => {} } },
    ],
  });
  return TestBed.createComponent(AccountForm).componentInstance;
}

describe('AccountForm payload', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('defaults to a cash account with empty settings', () => {
    const form = createForm({ currency: 'USD' });
    form.form.patchValue({ name: 'Wallet', currency: 'USD', startBalance: 0 });

    expect(form.buildPayload()).toEqual({
      name: 'Wallet', currency: 'USD', startBalance: 0,
      type: 'cash', settings: {},
    });
  });

  it('sends only crypto keys for a crypto account', () => {
    const form = createForm({ currency: 'BTC' });
    form.form.patchValue({
      name: 'Ledger', currency: 'BTC', startBalance: 0,
      type: 'crypto', address: 'bc1qxy2k', blockchain: 'bitcoin',
    });

    expect(form.buildPayload()).toEqual({
      name: 'Ledger', currency: 'BTC', startBalance: 0,
      type: 'crypto', settings: { address: 'bc1qxy2k', blockchain: 'bitcoin' },
    });
  });

  it('omits blank optional fields instead of sending empty strings', () => {
    const form = createForm({ currency: 'USD' });
    form.form.patchValue({
      name: 'Checking', currency: 'USD', startBalance: 0,
      type: 'bank', accountNumber: '   ',
    });

    expect(form.buildPayload()).toEqual({
      name: 'Checking', currency: 'USD', startBalance: 0,
      type: 'bank', settings: {},
    });
  });

  it('drops the other type\'s fields when the type changes', () => {
    const form = createForm({ currency: 'USD' });
    form.form.patchValue({
      name: 'Switcher', currency: 'USD', startBalance: 0,
      type: 'bank', accountNumber: '111',
    });
    form.form.patchValue({ type: 'crypto', address: '0xabc' });

    const payload = form.buildPayload();
    expect(payload.settings).toEqual({ address: '0xabc' });
    expect(payload.settings).not.toHaveProperty('accountNumber');
  });

  it('populates type-specific controls when editing', () => {
    const form = createForm({
      id: 7, name: 'Checking', currency: 'USD', startBalance: 0,
      type: 'bank', settings: { accountNumber: 'DE89' },
    } as Partial<Account>);

    expect(form.form.getRawValue().type).toBe('bank');
    expect(form.form.getRawValue().accountNumber).toBe('DE89');
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

```bash
cd frontend && npm test
```

Expected: FAIL — `buildPayload` does not exist and the form has no `type` control.

- [ ] **Step 3: Update the component**

Replace `frontend/src/app/features/accounts/account-form/account-form.ts`:

```ts
import { afterNextRender, ChangeDetectionStrategy, Component, inject, signal } from '@angular/core';
import { toSignal } from '@angular/core/rxjs-interop';
import { FormControl, FormGroup, ReactiveFormsModule, Validators } from '@angular/forms';
import { TuiButton, TuiError, TuiFilterByInputPipe, TuiInput } from '@taiga-ui/core';
import { TuiChevron, TuiComboBox, TuiDataListWrapper, TuiInputNumber, TuiSelect } from '@taiga-ui/kit';
import { POLYMORPHEUS_CONTEXT } from '@taiga-ui/polymorpheus';
import type { TuiDialogContext } from '@taiga-ui/core';
import { AccountsState } from '../../../core/accounts.state';
import type { Account, AccountPayload, AccountType } from '../../../models/account';
import { firstValueFrom } from 'rxjs';
import { TuiAutoFocus } from '@taiga-ui/cdk/directives/auto-focus';
import { NotificationService } from '../../../core/notification.service';

const ACCOUNT_TYPES: readonly AccountType[] = ['cash', 'bank', 'crypto'];

const TYPE_LABELS: Record<AccountType, string> = {
  cash: 'Cash',
  bank: 'Bank',
  crypto: 'Crypto',
};

@Component({
  selector: 'app-account-form',
  imports: [ReactiveFormsModule, TuiInput, TuiInputNumber, TuiButton, TuiError, TuiChevron, TuiComboBox, TuiSelect, TuiDataListWrapper, TuiFilterByInputPipe, TuiAutoFocus],
  templateUrl: './account-form.html',
  styleUrl: './account-form.scss',
  changeDetection: ChangeDetectionStrategy.OnPush,
})
export class AccountForm {
  // `openCreate` passes only `{ currency }`, so the context data is a partial.
  private readonly context = inject<TuiDialogContext<Account | null, Partial<Account> | null>>(POLYMORPHEUS_CONTEXT);
  private readonly accountsState = inject(AccountsState);
  private readonly notifications = inject(NotificationService);

  readonly currencies = this.accountsState.currencies;
  readonly accountTypes = ACCOUNT_TYPES;
  readonly typeLabel = (type: AccountType): string => TYPE_LABELS[type];
  readonly loading = signal(false);
  readonly accountId = signal(this.context.data?.id ?? null);

  // One group holds the controls for every type. Rebuilding a FormGroup
  // inside a live reactive form breaks formControlName bindings and
  // subscriptions, and the field set is small and fixed, so irrelevant
  // controls are simply hidden and ignored when the payload is assembled.
  readonly form = new FormGroup({
    type: new FormControl<AccountType>(this.context.data?.type ?? 'cash', { nonNullable: true, validators: [Validators.required] }),
    name: new FormControl<string>(this.context.data?.name ?? '', { nonNullable: true, validators: [Validators.required] }),
    currency: new FormControl<string>(this.context.data?.currency ?? '', { nonNullable: true, validators: [Validators.required] }),
    startBalance: new FormControl<number>(this.context.data?.start_balance ?? 0, { nonNullable: true, validators: [Validators.required] }),
    accountNumber: new FormControl<string>('', { nonNullable: true }),
    address: new FormControl<string>('', { nonNullable: true }),
    blockchain: new FormControl<string>('', { nonNullable: true }),
  });

  readonly type = toSignal(this.form.controls.type.valueChanges, {
    initialValue: this.form.controls.type.value,
  });

  constructor() {
    const data = this.context.data;
    if (data?.type === 'bank') {
      this.form.controls.accountNumber.setValue(data.settings?.accountNumber ?? '');
    } else if (data?.type === 'crypto') {
      this.form.controls.address.setValue(data.settings?.address ?? '');
      this.form.controls.blockchain.setValue(data.settings?.blockchain ?? '');
    }

    // TEMPORARY WORKAROUND (Taiga UI bug): tuiComboBox's internal matching effect
    // nulls out the control on its first run (textfield display text is still
    // empty then), clobbering the initial currency value — re-apply it once the
    // view has finished rendering. Remove once fixed upstream; still present as
    // of @taiga-ui/kit 5.24.0. Only the currency combo box is affected; the
    // type selector and the settings inputs need no equivalent.
    const currency = this.context.data?.currency;
    if (currency) {
      afterNextRender(() => this.form.controls.currency.setValue(currency));
    }
  }

  // Assembles the request body from the controls belonging to the selected
  // type. Blank optional fields are omitted rather than sent as '', so the
  // stored settings hold only keys the user actually filled in.
  buildPayload(): AccountPayload {
    const raw = this.form.getRawValue();
    const base = { name: raw.name, currency: raw.currency, startBalance: raw.startBalance };
    const clean = (value: string): string | undefined => {
      const trimmed = value.trim();
      return trimmed === '' ? undefined : trimmed;
    };

    switch (raw.type) {
      case 'bank': {
        const accountNumber = clean(raw.accountNumber);
        return { ...base, type: 'bank', settings: accountNumber === undefined ? {} : { accountNumber } };
      }
      case 'crypto': {
        const address = clean(raw.address);
        const blockchain = clean(raw.blockchain);
        return {
          ...base,
          type: 'crypto',
          settings: {
            ...(address === undefined ? {} : { address }),
            ...(blockchain === undefined ? {} : { blockchain }),
          },
        };
      }
      default:
        return { ...base, type: 'cash', settings: {} };
    }
  }

  cancel(): void {
    this.context.completeWith(null);
  }

  async onSubmit() {
    if (this.form.invalid) return;

    try {
      this.loading.set(true);

      const id = this.context.data?.id;
      const payload = this.buildPayload();
      const obs = id != null
        ? this.accountsState.update(id, payload)
        : this.accountsState.create(payload);
      const response = await firstValueFrom(obs);
      this.context.completeWith(response.data);
    } catch (e) {
      this.notifications.showError(e, 'Failed to save account');
    } finally {
      this.loading.set(false);
    }
  }
}
```

- [ ] **Step 4: Update the template**

Replace `frontend/src/app/features/accounts/account-form/account-form.html`:

```html
<form [formGroup]="form" (ngSubmit)="onSubmit()" class="form" tuiTextfieldSize="m">
    <tui-textfield tuiChevron [tuiTextfieldCleaner]="false" [stringify]="typeLabel">
        <label tuiLabel>Type</label>
        <input tuiSelect formControlName="type" />
        <tui-data-list-wrapper *tuiDropdown [items]="accountTypes" [itemContent]="typeLabel" />
    </tui-textfield>

    <tui-textfield>
        <label tuiLabel>Name</label>
        <input tuiInput tuiAutoFocus formControlName="name" placeholder="Account name" />
    </tui-textfield>

    <div class="row">
        <tui-textfield>
            <label tuiLabel>Starting Balance</label>
            <input tuiInputNumber formControlName="startBalance" [min]="0" [quantum]="0.01" placeholder="0.00" />
        </tui-textfield>

        <tui-textfield tuiChevron class="currency" [tuiTextfieldCleaner]="false">
            <label tuiLabel>Currency</label>
            <input tuiComboBox formControlName="currency" placeholder="e.g. USD, EUR" [strict]="false" />
            <tui-data-list-wrapper *tuiDropdown [items]="currencies() | tuiFilterByInput" />
        </tui-textfield>
    </div>

    @if (type() === 'bank') {
        <tui-textfield>
            <label tuiLabel>Account Number</label>
            <input tuiInput formControlName="accountNumber" placeholder="IBAN or account number" />
        </tui-textfield>
    }

    @if (type() === 'crypto') {
        <tui-textfield>
            <label tuiLabel>Wallet Address</label>
            <input tuiInput formControlName="address" placeholder="Wallet address" />
        </tui-textfield>

        <tui-textfield>
            <label tuiLabel>Blockchain</label>
            <input tuiInput formControlName="blockchain" placeholder="e.g. bitcoin, ethereum" />
        </tui-textfield>
    }

    <div class="actions">
        <button tuiButton size="s" type="button" appearance="outline" (click)="cancel()">Cancel</button>
        <button tuiButton size="s" type="submit" [disabled]="loading()">
            {{ loading() ? 'Saving...' : (!!accountId() ? 'Save Changes' : 'Create Account') }}
        </button>
    </div>
</form>
```

- [ ] **Step 5: Run the tests**

```bash
cd frontend && npm test
```

Expected: all five new `AccountForm payload` tests PASS, and every pre-existing frontend test still passes.

If `[itemContent]="typeLabel"` does not render the labels, fall back to a plain data list — replace the type textfield's dropdown line with:

```html
        <tui-data-list-wrapper *tuiDropdown [items]="accountTypes" />
```

which shows the raw values (`cash`, `bank`, `crypto`). Confirm the rendering in Task 7 before settling on either form.

- [ ] **Step 6: Verify the production build**

```bash
cd frontend && npm run build
```

Expected: build succeeds. This catches template type errors that the unit tests do not reach.

- [ ] **Step 7: Commit**

```bash
git add frontend/src/app/features/accounts/account-form/
git commit -m "$(cat <<'EOF'
feat(accounts): account type selector and per-type settings fields

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
EOF
)"
```

---

### Task 7: End-to-end verification in the browser

**Files:** none — this task only exercises the running app.

**Interfaces:**
- Consumes: everything built in Tasks 1–6.
- Produces: confirmation that the dialog, the payload and the stored row agree.

- [ ] **Step 1: Start both servers**

```bash
docker-compose up -d          # if Postgres is not already running
cd backend && npm run dev     # terminal 1
cd frontend && npm start      # terminal 2
```

- [ ] **Step 2: Walk the form**

Open `http://localhost:4200`, sign in (or register), and open Accounts → Add Account. Check each of these:

1. The Type selector is the first field and reads `Cash`. The form otherwise looks as it did before — no extra fields.
2. Switching to `Bank` reveals exactly one field, Account Number. Switching to `Crypto` reveals Wallet Address and Blockchain, and the Account Number field is gone.
3. Create a crypto account with an address and a blockchain. It saves and appears in the list.
4. Reopen it via Edit. The type reads `Crypto` and both fields are populated from the stored settings.
5. Change its type to `Bank`, enter an account number, save, reopen. The type reads `Bank`, the account number is there, and the wallet fields are empty.
6. Create a cash account leaving every optional field untouched — it saves without error.

- [ ] **Step 3: Confirm what actually landed in the database**

```bash
docker-compose exec -T db psql -U postgres -d finance_db \
  -c "SELECT id, name, type, settings FROM accounts ORDER BY id DESC LIMIT 5;"
```

Expected: the crypto-then-bank account shows `type = bank` with settings holding **only** `accountNumber` — no leftover `address`. The cash account shows `type = cash` and `settings = {}`.

- [ ] **Step 4: Stop the servers**

Ctrl-C both terminals.

- [ ] **Step 5: Run the full suite one last time**

```bash
cd backend && npm test && cd ../frontend && npm test && npm run build
```

Expected: everything passes. Nothing to commit — this task changes no files.

---

## Notes for the executor

- **Tasks 2 and 3 are one commit**, split into two tasks because the schema change and the persistence change are separately reviewable. Task 2's step 5 deliberately ends with failing round-trip tests; do not "fix" them inside Task 2.
- **Do not add a GIN index on `settings`.** No query searches inside it.
- **Do not touch `account-tree-node`.** Showing type icons or addresses in the account list is a separate piece of work.
- If `tuiSelect` with `[stringify]` and `[itemContent]` fights you, the fallback in Task 6 step 5 is acceptable — the labels are cosmetic, the control values are what matter.
