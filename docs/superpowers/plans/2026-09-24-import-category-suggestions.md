# Import Category Suggestions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Pre-fill a category on each parsed statement row by voting over the user's own categorised transaction history, keyed by merchant and then by MCC.

**Architecture:** A pure module `backend/src/services/import/categorize.ts` turns `(payee, description)` into merchant/MCC keys and votes over history rows. `parseStatement` loads categorised history from every account the user can access, runs the vote, and adds `suggestedCategoryId` / `suggestionSource` to each row. The Angular review screen resolves the suggested id against the category tree on read, marks it with an icon, and sends it on submit like a hand-picked category.

**Tech Stack:** Node + Express + raw SQL (pg), Jest; Angular 22 standalone + signals, Taiga UI v5, Vitest via `ng test`.

**Spec:** `docs/superpowers/specs/2026-09-24-import-category-suggestions-design.md`

## Global Constraints

- Suggestion threshold: leading category share **≥ 0.6** (`SUGGESTION_MIN_SHARE`); a single history row is enough.
- Merchant key first, MCC only when the merchant key yields nothing.
- Expense rows (`amount < 0`) draw only on expense history; income rows only on income history. Transfers never count.
- Uncategorized categories (ids 3 and 4) never count as history.
- History comes from `getAccessibleAccountIds(userId)`; `transactions.user_id` is never an access filter (CLAUDE.md).
- `db/queries/*` filter by account id only.
- `reconcile` is not changed.
- `source` values: `'payee'` for any merchant-key hit, `'mcc'` for an MCC hit, `null` for none.
- Tooltip copy: `Suggested from history` (payee), `Suggested by merchant type` (mcc).
- Angular: standalone, `OnPush`, `computed()` not getters, native control flow, no `ngClass`/`ngStyle`.
- Frontend tests run only via `npx ng test --watch=false --include=…`, never bare `npx vitest`.
- Backend single test: `npx jest --testPathPatterns=<name>` from `backend/`.

## Review Focus

- Category tree still loading when the review dialog opens → the suggestion must still appear once it loads (Task 3 test "resolves a suggestion once the category tree arrives").
- Suggested id no longer in the user's tree (deleted, or another user's category not visible) → row shows no category and submits `null`, never a dangling id that reconcile would reject (Task 3 test "leaves an unknown suggestion uncategorised").
- A history row with empty payee and empty description → no key, no crash, no suggestion (Task 1 test "gives no merchant key for an empty row").
- Non-Latin payees such as `Прочие расходы` → normalisation must keep Cyrillic letters, not strip them to an empty key (Task 1 test "keeps Cyrillic letters").
- History with `description` NULL in the database → the query must hand `''`, not `null`, to `categoryKeys` (Task 2 query uses `COALESCE`; Task 2 test "tolerates history rows with a NULL description").

---

## File Structure

- Create `backend/src/services/import/categorize.ts` — key extraction, normalisation and voting. No DB access.
- Create `backend/src/test/importCategorize.test.ts` — unit tests for it.
- Modify `backend/src/db/queries/transactions.ts` — add `findCategorizedHistory`.
- Modify `backend/src/services/import/index.ts` — extend `ImportRow`, wire the suggestion into `parseStatement`.
- Modify `backend/src/test/importService.test.ts` — suggestion tests against a real DB.
- Modify `frontend/src/app/models/import.ts` — extend `ImportRow`.
- Modify `frontend/src/app/features/import/import-review/import-review.ts`, `.html`, `.scss`, `.spec.ts` — resolve, mark and submit suggestions.

---

### Task 1: Category suggestion module

**Files:**
- Create: `backend/src/services/import/categorize.ts`
- Test: `backend/src/test/importCategorize.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `SUGGESTION_MIN_SHARE = 0.6`
  - `type Side = 'expense' | 'income'`
  - `interface HistoryRow { categoryId: number; side: Side; payee: string | null; description: string }`
  - `interface SuggestionInput { amount: number; payee: string | null; description: string }`
  - `type SuggestionSource = 'payee' | 'mcc'`
  - `interface Suggestion { categoryId: number | null; source: SuggestionSource | null }`
  - `normalizeKey(text: string): string | null`
  - `categoryKeys(payee: string | null, description: string): { merchant: string | null; mcc: string | null }`
  - `suggestCategories(rows: SuggestionInput[], history: HistoryRow[]): Suggestion[]` — same length and order as `rows`.

- [ ] **Step 1: Write the failing tests**

Create `backend/src/test/importCategorize.test.ts`:

```ts
import {
  HistoryRow,
  categoryKeys,
  normalizeKey,
  suggestCategories,
} from '../services/import/categorize';

const BOC_CARD =
  'EE 5812 KADRIORU LOSSIKOHVIK PURCHASE Card 4***2037 2026-09-19 6.00 EUR Auth 339449 Trace 599652';
const BOC_CARD_NO_MCC =
  'SECOND CUP PURCHASE CY Card 4***2037 2026-07-08 11.55 EUR Auth 362898 Trace 838125';
const LHV_CARD =
  '(..8306) 2023-03-03 19:08 KFC KRISTIINE \\ENDLA 45 \\TALLINN \\10615 ESTEST';

const expense = (categoryId: number, payee: string | null, description = ''): HistoryRow =>
  ({ categoryId, side: 'expense', payee, description });
const income = (categoryId: number, payee: string | null, description = ''): HistoryRow =>
  ({ categoryId, side: 'income', payee, description });

describe('normalizeKey', () => {
  it('ignores case, spaces and punctuation', () => {
    expect(normalizeKey('GOOGLE*YOUTUBEPREMIUM')).toBe(normalizeKey('GOOGLE *YouTubePremium'));
  });

  it('keeps Cyrillic letters', () => {
    expect(normalizeKey('Прочие расходы')).toBe('ПРОЧИЕРАСХОДЫ');
  });

  it('returns null when nothing but punctuation is left', () => {
    expect(normalizeKey(' *-* ')).toBeNull();
  });
});

describe('categoryKeys', () => {
  it('takes the payee when there is one, even if the description also matches a pattern', () => {
    expect(categoryKeys('Kohvik OU', BOC_CARD).merchant).toBe('KOHVIKOU');
  });

  it('extracts the merchant from a BoC card line with an MCC', () => {
    expect(categoryKeys(null, BOC_CARD)).toEqual({ merchant: 'KADRIORULOSSIKOHVIK', mcc: '5812' });
  });

  it('extracts the merchant from a BoC card line without an MCC', () => {
    expect(categoryKeys(null, BOC_CARD_NO_MCC)).toEqual({ merchant: 'SECONDCUP', mcc: null });
  });

  it('extracts the merchant from an LHV card line', () => {
    expect(categoryKeys('', LHV_CARD)).toEqual({ merchant: 'KFCKRISTIINE', mcc: null });
  });

  it('falls back to the whole description', () => {
    expect(categoryKeys(null, 'IBU-Maintenance Fees').merchant).toBe('IBUMAINTENANCEFEES');
  });

  it('gives no merchant key for an all-punctuation payee', () => {
    expect(categoryKeys('***', 'anything').merchant).toBeNull();
  });

  it('gives no merchant key for an empty row', () => {
    expect(categoryKeys(null, '')).toEqual({ merchant: null, mcc: null });
  });
});

describe('suggestCategories', () => {
  it('suggests the only category a merchant was ever filed under', () => {
    const [s] = suggestCategories(
      [{ amount: -5, payee: 'MERCADONA CALAHONDA', description: '' }],
      [expense(10, 'Mercadona Calahonda')]
    );
    expect(s).toEqual({ categoryId: 10, source: 'payee' });
  });

  it('matches a BoC description against an LHV payee for the same merchant', () => {
    const [s] = suggestCategories(
      [{ amount: -6, payee: null, description: BOC_CARD }],
      [expense(22, 'KADRIORU LOSSIKOHVIK')]
    );
    expect(s).toEqual({ categoryId: 22, source: 'payee' });
  });

  it('suggests at exactly the 0.6 threshold', () => {
    const history = [10, 10, 10, 11, 11].map(id => expense(id, 'PORT DESINA'));
    const [s] = suggestCategories([{ amount: -1, payee: 'PORT DESINA', description: '' }], history);
    expect(s.categoryId).toBe(10);
  });

  it('does not suggest for a key split below the threshold', () => {
    const history = [10, 10, 11, 12, 13].map(id => expense(id, 'Прочие расходы'));
    const [s] = suggestCategories([{ amount: -1, payee: 'Прочие расходы', description: '' }], history);
    expect(s).toEqual({ categoryId: null, source: null });
  });

  it('never uses expense history for an income row', () => {
    const [s] = suggestCategories(
      [{ amount: 100, payee: 'ACME', description: '' }],
      [expense(10, 'ACME')]
    );
    expect(s.categoryId).toBeNull();
  });

  it('uses income history for an income row', () => {
    const [s] = suggestCategories(
      [{ amount: 100, payee: 'ACME', description: '' }],
      [expense(10, 'ACME'), income(20, 'ACME')]
    );
    expect(s.categoryId).toBe(20);
  });

  it('falls back to the MCC when the merchant is unknown', () => {
    const [s] = suggestCategories(
      [{ amount: -6, payee: null, description: BOC_CARD }],
      [expense(30, null, 'EE 5812 OTHER CAFE PURCHASE Card 4***2037 2026-01-01 3.00 EUR')]
    );
    expect(s).toEqual({ categoryId: 30, source: 'mcc' });
  });

  it('prefers the merchant over the MCC when both match', () => {
    const [s] = suggestCategories(
      [{ amount: -6, payee: null, description: BOC_CARD }],
      [
        expense(30, null, 'EE 5812 OTHER CAFE PURCHASE Card 4***2037 2026-01-01 3.00 EUR'),
        expense(22, 'KADRIORU LOSSIKOHVIK'),
      ]
    );
    expect(s).toEqual({ categoryId: 22, source: 'payee' });
  });

  it('falls back to the MCC when the merchant key is below the threshold', () => {
    const [s] = suggestCategories(
      [{ amount: -6, payee: null, description: BOC_CARD }],
      [
        expense(22, 'KADRIORU LOSSIKOHVIK'),
        expense(23, 'KADRIORU LOSSIKOHVIK'),
        expense(30, null, 'EE 5812 OTHER CAFE PURCHASE Card 4***2037 2026-01-01 3.00 EUR'),
      ]
    );
    expect(s).toEqual({ categoryId: 30, source: 'mcc' });
  });

  it('returns one result per row, in order', () => {
    const result = suggestCategories(
      [
        { amount: -1, payee: 'A', description: '' },
        { amount: -1, payee: 'UNKNOWN', description: '' },
        { amount: -1, payee: 'B', description: '' },
      ],
      [expense(1, 'A'), expense(2, 'B')]
    );
    expect(result.map(s => s.categoryId)).toEqual([1, null, 2]);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `backend/`): `npx jest --testPathPatterns=importCategorize`
Expected: FAIL — `Cannot find module '../services/import/categorize'`.

- [ ] **Step 3: Implement the module**

Create `backend/src/services/import/categorize.ts`:

```ts
/**
 * Category suggestions for imported rows, learned from the user's own
 * categorised history. Pure: the caller loads the history.
 *
 * A row is keyed by merchant and by MCC; each key votes with the categories
 * history filed it under. The merchant key is tried first because it is
 * specific; the MCC ("5812 = restaurants") only when the merchant is unknown
 * or ambiguous.
 */

/** A key's leading category must hold at least this share of its votes. */
export const SUGGESTION_MIN_SHARE = 0.6;

export type Side = 'expense' | 'income';

export interface HistoryRow {
  categoryId: number;
  side: Side;
  payee: string | null;
  description: string;
}

export interface SuggestionInput {
  /** Signed: negative is an expense. */
  amount: number;
  payee: string | null;
  description: string;
}

export type SuggestionSource = 'payee' | 'mcc';

export interface Suggestion {
  categoryId: number | null;
  source: SuggestionSource | null;
}

/**
 * Where a merchant hides in a description when there is no payee, first
 * match wins. BoC card lines ("EE 5812 KADRIORU LOSSIKOHVIK PURCHASE Card…",
 * or without the country/MCC prefix), then LHV card lines as older history
 * stores them ("(..8306) 2023-03-03 19:08 KFC KRISTIINE \ENDLA 45…").
 */
const MERCHANT_PATTERNS = [
  /^[A-Z]{2} \d{4} (.+?) PURCHASE\b/,
  /^(.+?) PURCHASE\b/,
  /^\(\.\.\d{4}\) \d{4}-\d{2}-\d{2} \d{2}:\d{2} ([^\\]+)/,
];

const MCC_PATTERN = /^[A-Z]{2} (\d{4}) /;

/** Upper-cased letters and digits only, so "GOOGLE *YouTube" = "GOOGLE*YOUTUBE". */
export function normalizeKey(text: string): string | null {
  const key = text.toUpperCase().replace(/[^\p{L}\p{N}]/gu, '');
  return key || null;
}

export function categoryKeys(
  payee: string | null,
  description: string
): { merchant: string | null; mcc: string | null } {
  const desc = description.trim();
  let merchant = payee?.trim() ?? '';
  if (!merchant) {
    for (const pattern of MERCHANT_PATTERNS) {
      const m = desc.match(pattern);
      if (m) {
        merchant = m[1];
        break;
      }
    }
  }
  if (!merchant) merchant = desc;
  return { merchant: normalizeKey(merchant), mcc: desc.match(MCC_PATTERN)?.[1] ?? null };
}

/** key → categoryId → number of history rows. */
type Votes = Map<string, Map<number, number>>;

function vote(votes: Votes, key: string, categoryId: number): void {
  let byCategory = votes.get(key);
  if (!byCategory) {
    byCategory = new Map();
    votes.set(key, byCategory);
  }
  byCategory.set(categoryId, (byCategory.get(categoryId) ?? 0) + 1);
}

/**
 * The leading category, if it clears the threshold. No tie-break: two
 * categories tied on count each hold at most half, below the threshold.
 */
function winner(byCategory: Map<number, number> | undefined): number | null {
  if (!byCategory) return null;
  let total = 0;
  let best: number | null = null;
  let bestCount = 0;
  for (const [categoryId, count] of byCategory) {
    total += count;
    if (count > bestCount) {
      best = categoryId;
      bestCount = count;
    }
  }
  return bestCount / total >= SUGGESTION_MIN_SHARE ? best : null;
}

export function suggestCategories(rows: SuggestionInput[], history: HistoryRow[]): Suggestion[] {
  const byMerchant: Votes = new Map();
  const byMcc: Votes = new Map();
  for (const h of history) {
    const keys = categoryKeys(h.payee, h.description);
    if (keys.merchant) vote(byMerchant, `${h.side}|${keys.merchant}`, h.categoryId);
    if (keys.mcc) vote(byMcc, `${h.side}|${keys.mcc}`, h.categoryId);
  }

  return rows.map(row => {
    const side: Side = row.amount < 0 ? 'expense' : 'income';
    const keys = categoryKeys(row.payee, row.description);

    const merchant = keys.merchant ? winner(byMerchant.get(`${side}|${keys.merchant}`)) : null;
    if (merchant !== null) return { categoryId: merchant, source: 'payee' };

    const mcc = keys.mcc ? winner(byMcc.get(`${side}|${keys.mcc}`)) : null;
    if (mcc !== null) return { categoryId: mcc, source: 'mcc' };

    return { categoryId: null, source: null };
  });
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run (from `backend/`): `npx jest --testPathPatterns=importCategorize`
Expected: PASS, 20 tests.

- [ ] **Step 5: Commit**

```bash
git add backend/src/services/import/categorize.ts backend/src/test/importCategorize.test.ts
git commit -m "feat(import): suggest categories by voting over history"
```

---

### Task 2: Suggestions in `POST /api/import/parse`

**Files:**
- Modify: `backend/src/db/queries/transactions.ts` (add after `findByDates`, ~line 377)
- Modify: `backend/src/services/import/index.ts:1-22` (imports, `ImportRow`) and `parseStatement` (~line 104-125)
- Test: `backend/src/test/importService.test.ts`

**Interfaces:**
- Consumes (Task 1): `suggestCategories(rows: SuggestionInput[], history: HistoryRow[]): Suggestion[]`, `SuggestionSource`, `HistoryRow` shape `{ categoryId, side, payee, description }`.
- Consumes (existing): `getAccessibleAccountIds(userId: number): Promise<number[]>` from `backend/src/services/access.ts`.
- Produces:
  - `findCategorizedHistory(accountIds: number[]): Promise<{ categoryId: number; side: 'expense' | 'income'; payee: string | null; description: string }[]>`
  - `ImportRow` gains `suggestedCategoryId: number | null` and `suggestionSource: 'payee' | 'mcc' | null` (JSON response of `/api/import/parse`; Task 3 mirrors it).

- [ ] **Step 1: Write the failing tests**

In `backend/src/test/importService.test.ts`:

Add three variables next to the existing `let` declarations (after line 13):

```ts
  let otherAccountId: number;
  let salaryCategoryId: number;
  let otherSalaryCategoryId: number;
```

At the end of `beforeAll` (after `usdAccountId = usd.rows[0].id;`) add:

```ts
    const other = await pool.query(
      `INSERT INTO accounts (user_id, name, currency, start_balance)
       VALUES ($1, 'Other EUR', 'EUR', 0) RETURNING id`,
      [otherUserId]
    );
    otherAccountId = other.rows[0].id;

    const mkIncomeCategory = async (ownerId: number) => {
      const c = await pool.query(
        `INSERT INTO categories (user_id, name, parent_id) VALUES ($1, 'Salary', 1) RETURNING id`,
        [ownerId]
      );
      return c.rows[0].id as number;
    };
    salaryCategoryId = await mkIncomeCategory(userId);
    otherSalaryCategoryId = await mkIncomeCategory(otherUserId);
```

Replace the existing `beforeEach` body so the other user's history is cleared too:

```ts
  beforeEach(async () => {
    await pool.query('DELETE FROM transactions WHERE user_id = ANY($1::int[])', [[userId, otherUserId]]);
  });
```

Append these tests inside the `describe('parseStatement', …)` block. LHV fixture row 0 is an income of +1305.28 from payee `MERCHANT 001`; history uses a different date and amount so it cannot also be flagged `possible_duplicate`.

```ts
  describe('category suggestions', () => {
    const seedIncome = (ownerId: number, accountId: number, categoryId: number, description: string | null = 'seed') =>
      pool.query(
        `INSERT INTO transactions
           (user_id, category_id, credit_account_id, debit, credit, date, description, payee)
         VALUES ($1, $2, $3, 1000, 1000, '2025-01-15', $4, 'Merchant 001')`,
        [ownerId, categoryId, accountId, description]
      );

    it('suggests the category the same payee was filed under before', async () => {
      await seedIncome(userId, eurAccountId, salaryCategoryId);
      const result = await parseStatement(userId, eurAccountId, fixtureB64('lhv', 'statement.csv'));
      expect(result.rows[0].suggestedCategoryId).toBe(salaryCategoryId);
      expect(result.rows[0].suggestionSource).toBe('payee');
    });

    it('learns from the user\'s other accounts, not just the one being imported into', async () => {
      await seedIncome(userId, usdAccountId, salaryCategoryId);
      const result = await parseStatement(userId, eurAccountId, fixtureB64('lhv', 'statement.csv'));
      expect(result.rows[0].suggestedCategoryId).toBe(salaryCategoryId);
    });

    it('ignores history on an account the user cannot access', async () => {
      await seedIncome(otherUserId, otherAccountId, otherSalaryCategoryId);
      const result = await parseStatement(userId, eurAccountId, fixtureB64('lhv', 'statement.csv'));
      expect(result.rows[0].suggestedCategoryId).toBeNull();
      expect(result.rows[0].suggestionSource).toBeNull();
    });

    it('ignores Uncategorized history', async () => {
      await seedIncome(userId, eurAccountId, 3);
      const result = await parseStatement(userId, eurAccountId, fixtureB64('lhv', 'statement.csv'));
      expect(result.rows[0].suggestedCategoryId).toBeNull();
    });

    it('tolerates history rows with a NULL description', async () => {
      await seedIncome(userId, eurAccountId, salaryCategoryId, null);
      const result = await parseStatement(userId, eurAccountId, fixtureB64('lhv', 'statement.csv'));
      expect(result.rows[0].suggestedCategoryId).toBe(salaryCategoryId);
    });

    it('returns null suggestions when there is no history at all', async () => {
      const result = await parseStatement(userId, eurAccountId, fixtureB64('lhv', 'statement.csv'));
      expect(result.rows.every(r => r.suggestedCategoryId === null && r.suggestionSource === null)).toBe(true);
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `backend/`): `npx jest --testPathPatterns=importService`
Expected: FAIL — the new tests see `suggestedCategoryId` as `undefined`; `tsc` in ts-jest may also report the property missing on `ImportRow`.

- [ ] **Step 3: Add the history query**

In `backend/src/db/queries/transactions.ts`, directly after `findByDates`, add:

```ts
/**
 * Categorised expenses and incomes on these accounts, the history import
 * learns category suggestions from. Transfers and the Uncategorized
 * categories (3, 4) are left out: neither says anything about a merchant.
 */
export const findCategorizedHistory = async (
  accountIds: number[]
): Promise<{
  categoryId: number;
  side: 'expense' | 'income';
  payee: string | null;
  description: string;
}[]> => {
  if (accountIds.length === 0) return [];
  return query<{
    categoryId: number;
    side: 'expense' | 'income';
    payee: string | null;
    description: string;
  }>(
    `SELECT category_id AS "categoryId",
            CASE WHEN debit_account_id IS NOT NULL THEN 'expense' ELSE 'income' END AS side,
            payee,
            COALESCE(description, '') AS description
     FROM transactions
     WHERE category_id IS NOT NULL
       AND category_id NOT IN (3, 4)
       AND ((debit_account_id = ANY($1::int[]) AND credit_account_id IS NULL)
         OR (credit_account_id = ANY($1::int[]) AND debit_account_id IS NULL))`,
    [accountIds]
  );
};
```

- [ ] **Step 4: Wire it into `parseStatement`**

In `backend/src/services/import/index.ts`:

Change the access import and add the categorize import:

```ts
import { LEVEL, getAccessibleAccountIds, requireLevel } from '../access';
```

```ts
import { suggestCategories, SuggestionSource } from './categorize';
```

Extend `ImportRow` (after `duplicateOf: number | null;`):

```ts
  /** Pre-filled category, learned from history; null when nothing is confident. */
  suggestedCategoryId: number | null;
  suggestionSource: SuggestionSource | null;
```

Directly before `const out: ImportRow[] = rows.map((row, i) => {` add:

```ts
  // History from every account the user can see, not just this one: the
  // same merchant is usually paid from several accounts.
  const history = await transactionQueries.findCategorizedHistory(
    await getAccessibleAccountIds(userId)
  );
  const suggestions = suggestCategories(rows, history);
```

In the object returned from that `rows.map`, after `duplicateOf,` add:

```ts
      suggestedCategoryId: suggestions[i].categoryId,
      suggestionSource: suggestions[i].source,
```

- [ ] **Step 5: Run the tests to verify they pass**

Run (from `backend/`): `npx jest --testPathPatterns=importService`
Expected: PASS, including the 6 new tests.

- [ ] **Step 6: Run the whole backend suite and the type check**

Run (from `backend/`): `npm test && npx tsc --noEmit -p .`
Expected: all suites pass, `tsc` prints nothing.

- [ ] **Step 7: Commit**

```bash
git add backend/src/db/queries/transactions.ts backend/src/services/import/index.ts backend/src/test/importService.test.ts
git commit -m "feat(import): return category suggestions from parse"
```

---

### Task 3: Review screen pre-fills and marks suggestions

**Files:**
- Modify: `frontend/src/app/models/import.ts:11-19` (`ImportRow`)
- Modify: `frontend/src/app/features/import/import-review/import-review.ts`
- Modify: `frontend/src/app/features/import/import-review/import-review.html:51-57`
- Modify: `frontend/src/app/features/import/import-review/import-review.scss`
- Test: `frontend/src/app/features/import/import-review/import-review.spec.ts`

**Interfaces:**
- Consumes (Task 2): each parsed row carries `suggestedCategoryId: number | null` and `suggestionSource: 'payee' | 'mcc' | null`.
- Consumes (existing): `CategoriesState.categories: Signal<Category[]>` (a tree: roots with `children`), `findCategoryById(id: number | undefined, categories: Category[]): Category | null` from `models/category.ts`.
- Produces: `ReviewRow.suggested: boolean`; `ImportReview.categoryOf(row: ReviewRow): Category | null`; `ImportReview.suggestionHint(row: ReviewRow): string`.

- [ ] **Step 1: Write the failing tests**

In `import-review.spec.ts`:

Add `WritableSignal` to the Angular import:

```ts
import { signal, type WritableSignal } from '@angular/core';
```

Extend `makeRow` so rows carry the new fields (add after `duplicateOf: …,`):

```ts
    suggestedCategoryId: null,
    suggestionSource: null,
```

Let `configure` take the category tree as a signal, so a test can load it late. Replace its signature and the `CategoriesState` provider:

```ts
function configure(
  result: ImportParseResult,
  api: Partial<ApiService> = {},
  categories: WritableSignal<Category[]> = signal(tree)
) {
```

```ts
      { provide: CategoriesState, useValue: { categories } },
```

Append a new `describe` block inside `describe('ImportReview', …)`:

```ts
  describe('category suggestions', () => {
    const suggested = (id: number | null, source: 'payee' | 'mcc' = 'payee'): ImportRow => ({
      ...makeRow(0, 'new'),
      suggestedCategoryId: id,
      suggestionSource: id === null ? null : source,
    });

    it('pre-fills the suggested category and marks it', () => {
      const { component } = configure(makeResult([suggested(10)]));
      const row = component.rows()[0];
      expect(component.categoryOf(row)).toBe(groceries);
      expect(row.suggested).toBe(true);
    });

    it('leaves a row without a suggestion unmarked', () => {
      const { component } = configure(makeResult([suggested(null)]));
      const row = component.rows()[0];
      expect(component.categoryOf(row)).toBeNull();
      expect(row.suggested).toBe(false);
    });

    it('drops the mark once the user picks a category', () => {
      const { component } = configure(makeResult([suggested(10)]));
      component.setCategory(0, null);
      const row = component.rows()[0];
      expect(row.suggested).toBe(false);
      expect(component.categoryOf(row)).toBeNull();
    });

    it('leaves an unknown suggestion uncategorised', async () => {
      const reconcileImport = vi.fn().mockReturnValue(of({ data: { created: 1, skipped: 0 }, error: null }));
      const { component } = configure(makeResult([suggested(999)]), { reconcileImport } as never);

      expect(component.categoryOf(component.rows()[0])).toBeNull();
      await component.submit();
      expect(reconcileImport.mock.calls[0][1][0].categoryId).toBeNull();
    });

    it('resolves a suggestion once the category tree arrives', () => {
      const categories = signal<Category[]>([]);
      const { component } = configure(makeResult([suggested(10)]), {}, categories);
      expect(component.categoryOf(component.rows()[0])).toBeNull();

      categories.set(tree);

      expect(component.categoryOf(component.rows()[0])).toBe(groceries);
    });

    it('submits an accepted suggestion', async () => {
      const reconcileImport = vi.fn().mockReturnValue(of({ data: { created: 1, skipped: 0 }, error: null }));
      const { component } = configure(makeResult([suggested(10)]), { reconcileImport } as never);

      await component.submit();

      expect(reconcileImport.mock.calls[0][1][0].categoryId).toBe(10);
    });

    it('names where the suggestion came from', () => {
      const { component } = configure(makeResult([suggested(10, 'payee'), { ...suggested(10, 'mcc'), index: 1 }]));
      const [fromHistory, fromMcc] = component.rows();
      expect(component.suggestionHint(fromHistory)).toBe('Suggested from history');
      expect(component.suggestionHint(fromMcc)).toBe('Suggested by merchant type');
    });
  });
```

- [ ] **Step 2: Run the tests to verify they fail**

Run (from `frontend/`): `npx ng test --watch=false --include=src/app/features/import/import-review/import-review.spec.ts`
Expected: FAIL — TypeScript errors: `suggestedCategoryId` does not exist on `ImportRow`, `categoryOf` / `suggestionHint` / `suggested` do not exist.

- [ ] **Step 3: Extend the model**

In `frontend/src/app/models/import.ts`, inside `ImportRow` after `duplicateOf: number | null;`:

```ts
  /** Pre-filled category, learned from history; null when nothing is confident. */
  suggestedCategoryId: number | null;
  /** 'payee' = matched by merchant, 'mcc' = matched by merchant type. */
  suggestionSource: 'payee' | 'mcc' | null;
```

- [ ] **Step 4: Resolve, mark and submit suggestions in the component**

In `import-review.ts`:

Update imports:

```ts
import { TuiAppearance, TuiButton, TuiCheckbox, TuiHint, TuiIcon, TuiLoader } from '@taiga-ui/core';
```

```ts
import { CategoriesState } from '../../../core/categories.state';
import { findCategoryById } from '../../../models/category';
import type { Category } from '../../../models/category';
```

Extend `ReviewRow`:

```ts
/** A parsed row plus the things the user controls on this screen. */
export interface ReviewRow extends ImportRow {
  selected: boolean;
  /** The user's own pick; ignored while `suggested` is true. */
  category: Category | null;
  /** True until the user touches the category: the server's suggestion stands. */
  suggested: boolean;
}
```

Add `TuiIcon` and `TuiHint` to the component's `imports` array (after `TuiLoader,`).

Add the injection next to the others:

```ts
  private readonly categories = inject(CategoriesState);
```

In the `rows` initialiser, set `suggested` alongside `category: null`:

```ts
      category: null,
      suggested: row.suggestedCategoryId !== null,
```

Add after `rootIdFor`:

```ts
  /**
   * The row's effective category: the server's suggestion until the user
   * picks one. Looked up on read rather than once at construction, so a
   * suggestion still lands when the category tree loads after the dialog
   * opens; an id missing from the tree resolves to no category.
   */
  readonly categoryOf = (row: ReviewRow): Category | null =>
    row.suggested
      ? findCategoryById(row.suggestedCategoryId ?? undefined, this.categories.categories())
      : row.category;

  readonly suggestionHint = (row: ReviewRow): string =>
    row.suggestionSource === 'mcc' ? 'Suggested by merchant type' : 'Suggested from history';
```

Change `setCategory` so a pick ends the suggestion:

```ts
  setCategory(index: number, category: Category | null): void {
    this.rows.update(rows =>
      rows.map(r => (r.index === index ? { ...r, category, suggested: false } : r))
    );
  }
```

In `submit`, send the effective category:

```ts
        categoryId: this.categoryOf(r)?.id ?? null,
```

- [ ] **Step 5: Show the category and the marker in the template**

In `import-review.html`, replace the `<td class="col-category">…</td>` cell with:

```html
                        <td class="col-category">
                            <div class="category-cell">
                                <app-category-select
                                    [rootId]="rootIdFor(row)"
                                    [label]="''"
                                    [ngModel]="categoryOf(row)"
                                    (ngModelChange)="setCategory(row.index, $event)" />
                                @if (row.suggested && categoryOf(row)) {
                                    <tui-icon
                                        class="suggested"
                                        icon="@tui.sparkles"
                                        [tuiHint]="suggestionHint(row)"
                                        [attr.aria-label]="suggestionHint(row)" />
                                }
                            </div>
                        </td>
```

In `import-review.scss`, after the `.col-category` rule add:

```scss
.category-cell {
    display: flex;
    align-items: center;
    gap: 0.25rem;
}

.suggested {
    flex-shrink: 0;
    color: var(--tui-text-tertiary);
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run (from `frontend/`): `npx ng test --watch=false --include=src/app/features/import/import-review/import-review.spec.ts`
Expected: PASS, including the 7 new tests and every existing one.

- [ ] **Step 7: Run the whole frontend suite and a build**

Run (from `frontend/`): `npm test -- --watch=false && npm run build`
Expected: all specs pass; build succeeds with no template type errors.

- [ ] **Step 8: Check it in the running app**

Start backend (`npm run dev` in `backend/`) and frontend (`npm start` in `frontend/`), log in as a user with history, import `backend/banks/lhv/EE657…_Account_Statement_….csv` into an EUR account. Expected: most rows arrive with a category and a sparkles icon; hovering shows "Suggested from history"; changing a category removes the icon. Cancel the dialog instead of importing unless you mean to keep the data.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/app/models/import.ts frontend/src/app/features/import/import-review/
git commit -m "feat(import): pre-fill suggested categories on the review screen"
```
