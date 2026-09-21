# Bank statement import — backend

**Date:** 2026-09-21
**Status:** Approved, ready for implementation planning
**Scope:** Backend only. The frontend import UI is a separate piece of work.

## Problem

Every transaction is typed in by hand. Banks already publish the same
data as downloadable statements, so the work is transcription.

Two things make importing them harder than reading a CSV. Statements
disagree about almost every detail — date format, decimal separator,
whether an amount is signed or split across two columns, whether there
is a preamble before the header — so a single generic parser guesses,
and guesses wrongly. And statements overlap: the same transaction
appears in two exports covering adjacent periods, so importing twice
must not produce the transaction twice.

Three real statements, all in `backend/banks/`, define the problem:

| | LHV | Bank of Cyprus | CaixaBank |
|---|---|---|---|
| Container | CSV | CSV | binary `.xls` (BIFF8) |
| Preamble | none | 5 lines | 2 lines |
| BOM | yes | no | n/a |
| Date | `2026-07-01` | `21/09/2026` | `dd/MM/yyyy` |
| Decimals | `1305.28` | `"39.384,54"` | comma |
| Amount | signed + `D`/`C` column | split `Debit`/`Credit` | signed |
| Payee | own column | none | none |
| Currency | per-row column | preamble line | preamble line |
| Row order | oldest first | newest first | — |
| Unique reference | yes | yes | **none** |

## Approach

A registry of **format profiles**, where a profile is pure data
describing one bank's layout, and one set of code paths reads any
profile. Adding bank #4 is then a data change, not a code change.

Two endpoints, with no server state between them. `parse` turns an
uploaded file into rows and tells the caller which ones already exist;
`reconcile` takes back the rows the user chose and inserts them. The
client holds the rows in between.

Two alternatives were rejected. A single auto-detecting parser that
sniffs columns by header name needs no registry, but the table above
shows the variation is in the *values* — `31.12.2025` against
`2025-12-31`, `1 234,56` against `1234.56` — which a header sniffer
cannot see. A persisted staging table (parse writes rows, reconcile
references row ids) would survive a page reload and give an import
history, but it adds a table, a session lifecycle and a cleanup job to
solve a problem the client can solve by holding an array.

### Deferred

`.xls` is a **container** difference, not another profile: CaixaBank's
file is a real OLE2 compound document needing a spreadsheet library
before any column mapping can run. The profile carries a
`reader: 'csv' | 'xls'` field from the start and only the CSV reader
ships now, so adding SheetJS later touches no profile logic.

**Transfers are out of scope.** Every imported row becomes an income or
an expense. Recognising that a debit in one account and a credit in
another are one transfer is a separate feature.

## Module layout

```
src/services/import/
  index.ts        parseStatement(), reconcile()
  profiles.ts     the registry: lhv, boc
  csv.ts          RFC4180 reader -> string[][]
  hash.ts         computeImportHash()
src/routes/import.ts
src/db/migrations/011_add_transactions_import_hash.sql
```

### The profile

```ts
type Profile = {
  id: 'lhv' | 'boc';
  name: string;
  reader: 'csv';               // 'xls' slots in later
  encoding: 'utf8';            // future banks may need windows-1251
  delimiter: ',';
  skipLines: number;           // BoC: 5 preamble lines
  headerSignature: string[];   // identifies the format when none is given
  dateFormat: 'iso' | 'dd/mm/yyyy';
  decimal: 'dot' | 'comma';    // 'comma' implies '.' groups thousands
  amount:
    | { kind: 'signed'; column: string; directionColumn?: string }
    | { kind: 'split'; debitColumn: string; creditColumn: string };
  columns: { date: string; description: string; payee?: string };
  currency:
    | { from: 'column'; column: string }
    | { from: 'preamble'; line: number; after: string };
  identity:
    | { kind: 'reference'; columns: string[] }
    | { kind: 'content' };
};
```

Every row in the comparison table is a field here. `encoding` and
`reader` have one value each today; they exist because the next bank
will need them, and a field that is read but constant is cheaper than
retrofitting one.

`amount.directionColumn` is worth a note. LHV's `Amount` is already
signed consistently with its `D`/`C` column — 143 rows checked, no
disagreement — so the column is redundant *for this file*. It is used
as the authority anyway: a bank that exports unsigned amounts with a
direction flag is common, and trusting the explicit flag over an
inferred sign fails safe.

## Identity: how a row is recognised again

The duplicate problem splits by what the bank provides. LHV and Bank of
Cyprus both publish a unique reference per transaction; CaixaBank
publishes none, and CaixaBank is not exotic — a minimal
date/description/amount/balance export is a common shape.

So identity is **one nullable `import_hash` column**, and the profile
decides what is hashed:

- `identity: 'reference'` — `sha256(profileId | reference)`. Exact and
  stable: it survives the bank rewording a description, and re-importing
  the same transaction always matches.
- `identity: 'content'` — `sha256(profileId | date | amount |
  normalizedDescription | occurrenceIndex)`.

One column, one classification path, no branching in the service.

### The occurrence index

A content hash cannot tell two genuinely identical transactions apart,
and the LHV sample contains exactly that: four rows booked 2026-07-29,
each -10.00, sharing one merchant and one description. They are four
distinct charges, identical in every field the file exposes.

Within one parsed file the Nth identical row therefore gets a suffix —
`...|0`, `...|1`, `...|2`. Four identical charges yield four distinct
hashes, re-importing the same file matches all four, and a *third*
identical charge in a later statement correctly reads as new.

Two residual limitations, accepted rather than solved:

- If a later export covers an **overlapping period**, the counter
  restarts within that file, so overlapping windows containing repeated
  identical charges can mis-match. Reference-based banks are immune.
- A content hash is only as stable as the description text. If a bank
  reformats its wording, old rows stop matching and look new.

Both are narrow, and the alternative — no identity at all for
CaixaBank-shaped banks — is worse.

## Data model

Migration `011_add_transactions_import_hash.sql`:

```sql
ALTER TABLE transactions ADD COLUMN import_hash TEXT;

CREATE UNIQUE INDEX idx_transactions_import_hash_debit
  ON transactions(debit_account_id, import_hash)
  WHERE import_hash IS NOT NULL AND debit_account_id IS NOT NULL;

CREATE UNIQUE INDEX idx_transactions_import_hash_credit
  ON transactions(credit_account_id, import_hash)
  WHERE import_hash IS NOT NULL AND credit_account_id IS NOT NULL;
```

Two partial indexes because the account id lives in a different column
for income than for expense, and a hash is only unique *within* an
account — the same statement imported into two accounts is two
legitimate sets of rows.

The indexes are the real guarantee. The service checks for existing
hashes before inserting, but that check and the insert are not atomic
against a concurrent request; the index makes a double-submit
impossible rather than unlikely.

`import_hash` is nullable and manually entered transactions leave it
`NULL`, which the `WHERE` clauses exclude — so hand-entered rows are
never constrained against each other, however similar.

## `POST /api/import/parse`

```ts
// request
{ accountId: number, format?: 'lhv' | 'boc', content: string /* base64 */ }

// response
{ data: {
    format: 'lhv',
    account: { id, name, currency, scale },
    rows: [{
      index: 0,
      date: '2026-07-01',
      amount: 1305.28,          // decimal, signed: + income, - expense
      description: 'salary 06 2026',
      payee: 'UNLIMITED SERVICES OU',
      hash: 'a3f...',
      status: 'new' | 'duplicate' | 'possible_duplicate',
      duplicateOf: 1234 | null
    }],
    summary: { total: 143, new: 140, duplicate: 2, possibleDuplicate: 1 }
  }, error: null }
```

The file arrives base64 in a JSON body rather than as multipart. These
files are small — the 143-row LHV statement is 40KB — so multipart buys
streaming nobody needs, at the cost of a dependency and a second body
parser. Base64 also defers decoding to the profile's declared
`encoding`, which a multipart text read would have already guessed
wrongly for a windows-1251 file.

Order of work:

1. Decode base64.
2. `requireLevel(accountId, userId, LEVEL.WRITE)` — before any parsing.
3. Resolve the profile: explicit `format`, else match each profile's
   `headerSignature` against the file. No match is a 400 naming the
   supported formats.
4. Read rows via the container reader, map columns, normalise dates and
   decimals.
5. **Currency check.** The statement's currency against the account's.
   A mismatch is a 400 — a EUR statement landing in a USD account means
   the wrong account was picked, and importing it would write amounts
   that are wrong rather than merely mislabelled.
6. Compute hashes, including occurrence indices.
7. Classify.

Classification is two queries scoped to that account. Rows whose hash
is already in `transactions.import_hash` are `duplicate`. The remainder
are matched on same date and same amount — catching transactions typed
in by hand before importing ever started, which have no hash — and
flagged `possible_duplicate`.

The distinction is the point: `duplicate` is exact and the UI
pre-deselects it; `possible_duplicate` is advisory, stays selected, and
will sometimes be a real repeated charge rather than a duplicate. The
user decides on the soft ones.

Nothing is written. Parsing the same file twice changes nothing.

## `POST /api/import/reconcile`

```ts
// request
{ accountId: number,
  rows: [{ date, amount, description, payee, hash, categoryId? }] }

// response
{ data: { created: 140, skipped: 3, transactions: [...] }, error: null }
```

The rows come back from the client, so **nothing in them is trusted**.
The endpoint re-runs `requireLevel(accountId, userId, LEVEL.WRITE)`,
re-converts amounts to cents through the account's own `scale`, and
re-checks each hash — a client that skips `parse` entirely and posts
straight here gets the same treatment.

Only the hash is re-checked here; the date-and-amount heuristic is
**not** re-run. A row the user reviewed as `possible_duplicate` and
chose to keep must import. Re-applying the advisory match at this point
would silently discard exactly the rows the user made a decision about.

Direction follows the sign, matching what `createTransaction` already
does: negative fills `debit_account_id` (expense), positive fills
`credit_account_id` (income). A row without a `categoryId` inherits the
existing Uncategorized defaults (3 for income, 4 for expense) rather
than a special import-time rule.

All inserts run in one database transaction, with
`ON CONFLICT DO NOTHING` against the unique indexes; conflicts count
toward `skipped`. Either the whole batch lands or none of it does, and
a retry after a failure is safe.

## Testing

The parser tests run against **redacted copies of real statements**, in
`backend/src/test/fixtures/banks/`. The originals stay in
`backend/banks/`, which is gitignored — they carry IBANs, account
numbers, a name and a full spending history.

Redaction replaced identifying values and preserved every structural
property the parser depends on: the BOM, preamble line counts, column
count and order, quoting style (LHV quotes text but leaves date and
amount bare; BoC quotes only its comma-decimal numerics), date formats,
decimal and thousands separators, row order, the 10/133 credit-debit
split, and the run of four identical rows. Verified after generation —
LHV is 143 rows of 16 columns, BoC 10 rows of 10.

This keeps the tests honest about layout, which is where bank formats
actually differ, without putting personal finances in git history.

**`csv.ts`** — quoted fields containing commas (LHV descriptions are
full of them), BOM stripping, CRLF line endings, quoted quotes.

**Profiles** — LHV: 143 data rows, 10 credit and 133 debit, first row
parses to `2026-07-01 / +1305.28 / 'Description 1' / 'MERCHANT 001'`.
BoC: 5 preamble lines skipped, `"39.384,54"` reads as `39384.54`,
`21/09/2026` becomes `2026-09-21`, a `Debit` value becomes negative.

**Hashing** — the four identical rows booked 2026-07-29, each -10.00,
produce four distinct hashes; the same file hashed twice produces the
same values.

**`parse`** — auto-detects both formats without `format`; wrong-currency
account is a 400; unrecognised file is a 400; no WRITE access is a 403;
nothing is written to the database.

**`reconcile`** — creates the expected count; posting the same payload
twice creates nothing the second time; hash duplicates are skipped;
sign determines income against expense; access is enforced
independently of `parse`.

**Round trip** — parse the LHV fixture, reconcile it, parse it again:
all 143 rows come back `duplicate`. This is the property the whole
design exists to provide, so it is tested end to end against a real
statement's structure.

`importRoutes` is registered in both `src/index.ts` and
`src/test/testApp.ts`.
