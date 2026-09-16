# Account type and optional settings

## Problem

An account currently carries only a name, currency, scale and starting
balance. Real accounts have more: a bank account has an account number,
a crypto wallet has an address and a blockchain. More attributes will
follow, and more kinds of account (debt, investment) after that.

We need somewhere to put these optional attributes that does not
require a migration every time one is added, and that still rejects
nonsense — a wallet address on a cash account, a misspelled key.

## Approach

Give each account a `type` (`cash`, `bank`, `crypto`) and a JSONB
`settings` column whose shape is validated against a Zod schema chosen
by that type.

The type is a real column with a CHECK constraint, because types are
few and change rarely. The settings are JSONB, because the attributes
within a type are many and change often. Adding a field to an existing
type is a code change; adding a type is a one-line migration.

Two alternatives were rejected. Separate nullable columns per attribute
type the data properly but grow the table with mostly-empty columns and
demand a migration per attribute. Untyped JSONB with no discriminator
avoids migrations entirely but accepts any key on any account, which
defeats the point of validating at all.

## Data model

Migration `008_add_accounts_type_settings.sql`:

```sql
ALTER TABLE accounts
  ADD COLUMN type TEXT NOT NULL DEFAULT 'cash',
  ADD COLUMN settings JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE accounts
  ADD CONSTRAINT chk_accounts_type
  CHECK (type IN ('cash', 'bank', 'crypto'));
```

`DEFAULT 'cash'` migrates existing rows without a separate UPDATE.
Every account that exists today has no extra attributes, which is
exactly what `cash` means.

`settings` is `NOT NULL DEFAULT '{}'`. An empty object rather than NULL
removes the `null`-versus-`{}` branch from every consumer: reading code
always gets an object.

The constraint is named to match the existing
`chk_accounts_currency_format`. Adding a type later means `DROP
CONSTRAINT` plus `ADD CONSTRAINT` in a new migration.

No index on `settings`. A GIN index serves searching inside JSONB;
every query here is `WHERE user_id = $1` over a few dozen rows. Add one
when a query needs it.

`settings` participates in no database constraint. Its shape is
enforced only by Zod at the API boundary — a deliberate trade of
database-level guarantees for schema flexibility, acceptable because
this API is the only writer.

### Fields in this iteration

| Type | Settings |
|------|----------|
| `cash` | none |
| `bank` | `accountNumber?: string` |
| `crypto` | `address?: string`, `blockchain?: string` |

Every field is optional. `blockchain` is a free string, not an
enumeration: the list of chains is long and would go stale.

Statement format for CSV import is deliberately **out of scope**. The
importer does not exist yet, so the set of formats worth naming is not
yet known, and a field nothing reads is dead weight. It joins `bank`
settings when the importer is built.

Keys inside `settings` are camelCase. The table's own columns are
snake_case, but a JSONB document has no reason to follow SQL
convention, and the frontend then reads and writes the object
unchanged.

### Relationship to account groups

Accounts already form a tree via `/` in the name, built client-side by
`buildAccountTree` in `frontend/src/app/core/accounts.state.ts`. Those
groups are virtual — they have no database row. `type` and `settings`
belong to accounts only. Groups neither carry nor inherit a type.

## API

`backend/src/routes/accounts.ts` gains a discriminated union beside the
existing `currencySchema`:

The per-type settings shapes, with `z.strictObject` (Zod 4's spelling;
`.object().strict()` is deprecated there):

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
```

Strictness makes an unknown key a 400 rather than silently persisted
noise — without it a typo such as `adress` would live in the database
forever.

Validating type and settings together is the point of the
discriminated union: `settings.address` on a `bank` account is
rejected, which untyped JSONB could not do.

### Schemas

**The base fields are spread into each union member, not intersected
with `.and()`.** This is not a style preference. `.and()` produces a
`ZodIntersection`, which parses each side against the input
independently and merges the results; the strict settings object then
never sees a conflict, so `{ type: 'cash', settings: { accountNumber:
'1' } }` is *accepted*. Verified against the repo's own Zod 4.4.3:
with `.and()`, both the unknown-key case and the wrong-type-key case
pass; with the spread, both are rejected. Building the union with
`.and()` would silently disable the validation this design exists for.

A discriminated union also cannot be made `.partial()` — the
discriminant has to be present. So **PUT requires `type` on every
request**, even one that only renames. The alternative — infer the type
from the stored row, then validate settings against it — is materially
more logic, and it reintroduces exactly the merge semantics this design
rejects: a PUT with no `type` cannot express "keep the existing
settings" when settings are written whole.

The Angular form submits its full value via `getRawValue()`, so the UI
is unaffected. **The test suite is also a caller, and was not:** two
existing tests issued partial updates (`{ startBalance: N }`) and
expected 200. They now send `type: 'cash'` alongside the balance. Any
future non-form caller must send `type` too — this is a breaking change
to the PUT contract, not merely a new optional field.

A matching wrinkle applies to POST. `z.discriminatedUnion` cannot
select a member when the discriminant key is **absent entirely** — it
fails with "No matching discriminator" rather than falling back to a
default. Since creating an account without `type` must default to
`cash`, `createAccountSchema` is wrapped in a `z.preprocess` that
injects `type: 'cash'` when the key is missing, matching the idiom
already used in `routes/transactions.ts`. `updateAccountSchema` gets no
such wrapper — on PUT, a missing `type` is an error, by the paragraph
above.

```ts
const createBase = {
  name: z.string().min(1).max(255),
  currency: currencySchema,
  startBalance: z.number().default(0),
  scale: z.number().optional().default(2),
};

// The preprocess is required: a discriminated union cannot select a
// member when `type` is absent entirely, and an omitted type must
// default to cash.
const createAccountSchema = z.preprocess(
  (val) => (val && typeof val === 'object' && !('type' in val) ? { ...val, type: 'cash' } : val),
  z.discriminatedUnion('type', [
    z.strictObject({ ...createBase, type: z.literal('cash'), settings: settingsByType.cash }),
    z.strictObject({ ...createBase, type: z.literal('bank'), settings: settingsByType.bank }),
    z.strictObject({ ...createBase, type: z.literal('crypto'), settings: settingsByType.crypto }),
  ])
);

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

`z.strictObject` at the top level also rejects unknown top-level keys,
which the previous `z.object` did not. That is a behavior change worth
noting: a client sending a stray field now gets a 400 instead of having
it ignored. The only client is this frontend, which sends exactly these
fields.

The `validate` middleware replaces `req.body` with the parsed result,
so Zod's `settings: {}` default reaches the route handler.

### Service and queries

`type` and `settings` pass through `services/accounts.ts` and
`db/queries/accounts.ts` as ordinary fields. `toDecimalDTO` does not
touch them.

`updateAccount` writes `settings` **whole, with no COALESCE merge**.
Changing an account's type must drop the previous type's fields, and a
merge would preserve them. `{ type: 'bank', settings: {} }` stores
`{}`.

The `Account` interface in `backend/src/types/index.ts` gains `type:
AccountType` and `settings: Record<string, unknown>`.

## Frontend

### Model

`frontend/src/app/models/account.ts` mirrors the backend union so the
template can narrow:

```ts
export type AccountType = 'cash' | 'bank' | 'crypto';

export interface AccountSettings {
  cash: Record<string, never>;
  bank: { accountNumber?: string };
  crypto: { address?: string; blockchain?: string };
}

interface AccountBase {
  // id, user_id, name, currency, scale, start_balance,
  // balance, user_balance, deleted, created_at — unchanged
}

export type Account = {
  [T in AccountType]: AccountBase & { type: T; settings: AccountSettings[T] };
}[AccountType];
```

After `@if (account.type === 'crypto')`, TypeScript knows
`settings.address` exists.

The request body gets its own union, since `type` and `settings` always
travel together and PUT requires `type` too:

```ts
export type AccountPayload = {
  name: string;
  currency: string;
  startBalance: number;
} & {
  [T in AccountType]: { type: T; settings: AccountSettings[T] };
}[AccountType];
```

`ApiService.createAccount` / `.updateAccount` and
`AccountsState.create` / `.update` all take `AccountPayload`.

### Form

One `FormGroup` holds controls for every type. The group is not rebuilt
when the type changes; irrelevant controls are hidden with `@if` and
ignored when the payload is assembled.

```ts
readonly form = new FormGroup({
  type: new FormControl<AccountType>(this.context.data?.type ?? 'cash', { nonNullable: true }),
  name: /* unchanged */,
  currency: /* unchanged */,
  startBalance: /* unchanged */,
  accountNumber: new FormControl<string>(''),
  address: new FormControl<string>(''),
  blockchain: new FormControl<string>(''),
});

readonly type = toSignal(this.form.controls.type.valueChanges, {
  initialValue: this.form.controls.type.value,
});
```

Rebuilding a `FormGroup` inside a live reactive form causes
`formControlName` and subscription problems, and the field set here is
small and fixed, so a hidden control is the simpler answer.

`onSubmit` assembles `settings` from the controls belonging to the
selected type, dropping empty strings so a blank input omits the key
rather than storing `''`.

One consequence worth stating: switching to `bank`, typing a number,
switching to `crypto` and back leaves the number in the control — it
was only hidden. It is submitted only if the type is `bank` at submit
time, so the stored settings still match the stored type.

### Layout

The type selector is the first field, above Name: the type decides what
kind of account is being created, so it is chosen first. It is a
`tuiSelect` — the option list is fixed and short, so a combo box would
be the wrong control.

Type-specific fields sit inline below the existing fields, shown and
hidden with `@if`. For `cash` the block is empty and the form looks as
it does today. The dialog changing height on type change is acceptable.

Changing the type clears the other type's fields with no confirmation
prompt.

When editing, the type-specific controls are populated from
`context.data.settings`.

The `afterNextRender` workaround in `account-form.ts` is specific to a
`tuiComboBox` bug affecting the currency control. The new fields are
`tuiInput` and `tuiSelect` and need no equivalent.

### Display

`account-tree-node` is unchanged. This work covers storage; surfacing
type icons or wallet addresses in the account list is a separate task.

## Testing

Backend, extending `backend/src/test/accounts.test.ts`:

- Creating an account without `type` defaults to `cash` with `settings`
  of `{}`.
- Creating a `bank` account round-trips `accountNumber`.
- Creating a `crypto` account round-trips `address` and `blockchain`.
- `settings.address` on a `bank` account is a 400.
- An unknown settings key is a 400.
- An invalid type is a 400.
- Updating an account from `bank` to `crypto` replaces settings rather
  than merging: the stored object has no `accountNumber`.
- A PUT omitting `type` is a 400.

Frontend:

- `account-form.spec.ts`: the type selector shows the right fields per
  type; submitting a `crypto` account sends `settings` with only the
  crypto keys; a blank optional field is omitted from the payload.
- `accounts.state.spec.ts` already exercises tree building; extend the
  fixtures with `type` and `settings` so the new required model fields
  are covered.

Run with `npm test` in each package (the frontend uses `ng test`, not
bare `npx vitest run`).

## Migration and compatibility

Existing accounts become `cash` with empty settings when migration 008
runs. No data is lost and no backfill script is needed.

The API change is not backward compatible for PUT: a client that omits
`type` gets a 400. The only client is this repo's frontend, which is
updated in the same change.
