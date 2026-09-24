# Import — category suggestions

**Date:** 2026-09-24
**Status:** Draft, awaiting review
**Scope:** Backend (`POST /api/import/parse`) and the frontend review screen.
Builds on `2026-09-21-bank-statement-import-design.md`.

## Problem

After a statement is parsed, every row reaches the review screen with no
category, and reconcile files anything left blank under Uncategorized.
Picking a category by hand for 100+ rows is most of the work of an import,
and most of those choices repeat ones the user has already made: the same
supermarket, the same subscription, the same parking operator.

The history to learn from exists. On the development database:

- 15 183 transactions, 13 940 of them in a real (not Uncategorized) category;
- 6 909 carry a `payee`, and payees are stable — `PORT DESINA` appears 236
  times across just 2 categories;
- older card rows keep the merchant inside `description`
  (`(..8306) 2023-03-03 19:08 KFC KRISTIINE \ENDLA 45 \TALLINN …`);
- some legacy rows hold a category-like label in `payee`
  (`Прочие расходы`, 97 rows over 11 categories) — noise a suggestion must
  not follow.

Bank of Cyprus statements have no payee column, but every card line carries
the merchant and its MCC: `EE 5812 KADRIORU LOSSIKOHVIK PURCHASE Card 4***2037 …`.
Only 17 historical rows contain an MCC today, so MCC is a fallback that
improves as BoC imports get categorised, not a primary signal.

## Approach

Suggest a category for each parsed row by **voting over the user's own
categorised history**, keyed first by merchant and then by MCC. No new
tables, no rules UI, no external services. Correcting a suggestion during
review is what teaches the next import.

The suggestion is advisory: it pre-fills the row's category on the review
screen, the user can change it, and reconcile treats it exactly like a
category the user picked by hand.

### Deferred

- User-defined rules ("contains X → category Y").
- A static or per-user MCC → category table.
- LLM classification for rows with no match.
- Fuzzy matching (`Ristiku Selver ABC` vs `RISTIKU SELVER` stay distinct).
- A persisted normalised-key column; keys are computed in memory per parse.

## Module: `backend/src/services/import/categorize.ts`

Pure functions, no database access.

### Keys

`categoryKeys(payee: string | null, description: string): { merchant: string | null; mcc: string | null }`

The same function is applied to history rows and to parsed rows, so both
sides are keyed identically.

**Merchant**, first match wins:

1. `payee`, when non-empty after trimming.
2. BoC card line: `^[A-Z]{2} \d{4} (.+?) PURCHASE\b` → group 1
   (`EE 5812 KADRIORU LOSSIKOHVIK PURCHASE …` → `KADRIORU LOSSIKOHVIK`).
3. BoC card line without country/MCC: `^(.+?) PURCHASE\b` → group 1
   (`SECOND CUP PURCHASE CY Card …` → `SECOND CUP`).
4. LHV card line: `^\(\.\.\d{4}\) \d{4}-\d{2}-\d{2} \d{2}:\d{2} ([^\\]+)` → group 1
   (`(..8306) 2023-03-03 19:08 KFC KRISTIINE \ENDLA 45 …` → `KFC KRISTIINE`).
5. The whole `description`.

The chosen text is then **normalised**: upper-cased, and every character
that is not a Unicode letter or digit removed (`/[^\p{L}\p{N}]/gu`). So
`GOOGLE*YOUTUBEPREMIUM` and `GOOGLE *YouTubePremium` share a key. An empty
result means no merchant key.

Rule 5 keeps recurring non-card lines (`IBU-Maintenance Fees`) matchable.
Descriptions that embed dates or reference numbers simply never match
anything, which is harmless.

**MCC**: `^[A-Z]{2} (\d{4}) ` on `description` → group 1, else `null`.

### Voting

`suggestCategories(rows, history): Suggestion[]`, one result per row:

```ts
interface HistoryRow {
  categoryId: number;
  side: 'expense' | 'income';
  payee: string | null;
  description: string;
}

interface Suggestion {
  categoryId: number | null;
  source: 'payee' | 'mcc' | null;
}
```

1. Index history by `(side, merchant)` and by `(side, mcc)`, counting rows
   per category.
2. A parsed row's side is `expense` when `amount < 0`, else `income`.
   Expense rows never draw on income history and vice versa.
3. Look up the row's merchant key. The leading category wins when its
   share of that key's rows is **≥ 0.6** (`SUGGESTION_MIN_SHARE`). A single
   history row is enough (share 1.0). No tie-break is needed: two
   categories tied on count each hold at most half, below the threshold.
4. If the merchant key yields nothing (no key, no history, or below the
   threshold), repeat step 3 with the MCC key.
5. Otherwise, no suggestion.

`source` is `'payee'` for a merchant-key hit, whichever rule produced the
key; the name describes the signal to the user, not the extraction path.

## Backend changes

### History query

`transactionQueries.findCategorizedHistory(accountIds: number[])` in
`backend/src/db/queries/transactions.ts` returns, for transactions on the
given accounts:

- expenses (`debit_account_id = ANY($1) AND credit_account_id IS NULL`) and
  incomes (`credit_account_id = ANY($1) AND debit_account_id IS NULL`) —
  transfers excluded;
- only rows with `category_id` not null and not 3 / 4 (Uncategorized);
- columns `category_id`, side, `payee`, `description`.

Per CLAUDE.md, the query filters by account id only; `transactions.user_id`
is not used.

### `parseStatement`

After duplicate detection:

1. `getAccessibleAccountIds(userId)` — the same visibility every other
   transaction read uses, so history from accounts shared with the user
   counts and history from anyone else's does not.
2. `findCategorizedHistory(ids)`, then `suggestCategories(rows, history)`.
3. Each `ImportRow` gains:

   ```ts
   suggestedCategoryId: number | null;
   suggestionSource: 'payee' | 'mcc' | null;
   ```

Suggestions are computed for every row, `duplicate` included: it costs
nothing, and a duplicate the user deliberately re-selects arrives already
categorised.

A failing history query fails the parse, like any other database error in
this endpoint. Silently returning no suggestions would hide a regression.

### `reconcile`

Unchanged. It already accepts `categoryId`, validates it, and maps it
through `resolveCategoryForOwner` to the account owner's category. A
suggestion drawn from a shared account's history that names another user's
category therefore takes the same path as a hand-picked one.

## Frontend changes

- `models/import.ts`: `ImportRow` gains `suggestedCategoryId` and
  `suggestionSource`.
- `import-review.ts`:
  - `ReviewRow` gains `suggested: boolean`.
  - A row starts with `suggested = suggestedCategoryId !== null`. While
    `suggested`, its category is `suggestedCategoryId` looked up in
    `CategoriesState.categories()` on read — not once at construction, so a
    suggestion still lands if the category tree loads after the dialog
    opens. An unknown or deleted id resolves to no category.
  - `setCategory` clears `suggested`.
  - Submission sends the resolved category: `categoryId: categoryOf(r)?.id ?? null`.
- `import-review.html`: a suggested category shows a small marker beside
  the select, with a tooltip "Suggested from history" (`payee`) or
  "Suggested by merchant type" (`mcc`). Accepting a suggestion needs no
  action.

## Testing

**`categorize.ts` (unit)**

- Normalisation: `GOOGLE*YOUTUBEPREMIUM` and `GOOGLE *YouTubePremium` give
  the same key; an all-punctuation payee gives none.
- Merchant extraction for each rule, including payee taking precedence over
  a description that would also match.
- MCC extraction from a BoC line; `null` for an LHV line.
- Threshold: a key split 3/2 between two categories (0.6) suggests; one
  split across many categories (the `Прочие расходы` case) does not.
- Expense history never suggests for an income row.
- MCC is used only when the merchant key yields nothing.

**Backend API (`importApi.test.ts`)**

- A parsed row whose payee matches a categorised history transaction gets
  that `suggestedCategoryId` with `suggestionSource: 'payee'`.
- History on an account the user cannot access produces no suggestion.
- Uncategorized history produces no suggestion.

**Frontend (`import-review.spec.ts`)**

- A suggested category is pre-filled and marked.
- Changing the category clears the marker.
- An unknown `suggestedCategoryId` leaves the row uncategorised.
- A suggestion resolves once the category tree arrives after construction.
