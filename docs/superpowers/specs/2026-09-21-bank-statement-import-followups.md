# Bank statement import — known follow-ups

**Date:** 2026-09-21
**Status:** Deferred; none block use of the feature.
**Implements:** `2026-09-21-bank-statement-import-design.md`

Findings raised during implementation review and consciously deferred. Each
was judged not worth blocking the merge. They are recorded here because a
list nobody can find is the same as no list.

## Extensibility — matters when bank #3 arrives

**`encoding` and `reader` are declared but never read.** `profiles.ts`
defines both; nothing consults either. `parseStatement` hardcodes
`.toString('utf8')` and hardcodes `parseCsv`. The design argued these fields
were cheaper to carry than to retrofit — true, but as built they are
decorative, so a bank needing windows-1251 or a binary `.xls` still requires
editing `services/import/index.ts` and `rows.ts`, which is the code change
the registry existed to avoid.

Cheapest honest fix, roughly four lines: branch on `profile.reader` in
`parseStatement` with an explicit `throw { statusCode: 400, message: '.xls
statements are not supported yet' }` for anything else, and pass
`profile.encoding` to `Buffer.toString`. That turns two dead fields into the
seam they were meant to be.

**`parseCsv` filters blank rows position-destructively.** It drops `['']`
rows anywhere in the grid, not only trailing ones, while `profiles.ts`
(`skipLines`, `currency.line`) and `rows.ts` index the filtered grid by
absolute position. A bank whose preamble carries a blank separator line —
common enough — would silently mis-index its header and currency rather than
erroring. Both committed fixtures were verified to contain zero interior
blank lines, so nothing breaks today, and a comment at the filter now warns
about it. A profile that needs it could carry its own blank-line policy.

## Robustness

**No cap on rows per import.** `createImportedTransactions` builds one
INSERT with 10 placeholders per row, so it breaks at PostgreSQL's
65535-parameter ceiling — about 6,553 rows — with an opaque driver error. The
10 MB body limit permits a far larger file than that. Real statements are
two orders of magnitude smaller, but chunking at ~5,000 rows, or rejecting
above a sane count with a 400, turns a confusing failure into a clear one.

**`round2` and `toFixed(2)` hardcode two decimal places** (`rows.ts`,
`hash.ts`) regardless of `account.scale`. Accounts carry a client-settable
scale, so a scale-8 account importing a statement with more than two
decimals would lose precision before `toCents` saw it. Unreachable in
practice — the currency check forces statement and account to agree, and no
bank CSV publishes eight decimals — but the constant assumes fiat and should
say so. Note that changing it would change every stored content hash.

## Consistency

**`formatDate` is duplicated and has diverged.** `services/transactions.ts`
and `services/import/index.ts` each carry a copy; the import one slices the
string branch to 10 characters, the other returns it unchanged. Two copies
of a timezone-sensitive date formatter is how the `toISOString` bug this
feature already hit gets reintroduced in one place and not the other. Worth
hoisting into a shared helper.

**The reconcile response omits `transactions`.** The design document
promises `{ created, skipped, transactions: [...] }`; the implementation
returns `{ created, skipped }`, because returning 143 DTOs would need a
second query. Defensible, but it means the frontend must re-fetch after an
import, and that expectation is currently written down nowhere but here.

**`CreateTransactionData` widened to admit `null`** for
`debitAccountId`/`creditAccountId`/`payee`. Behaviour-neutral — both
consumers live in `db/queries/transactions.ts` and pass every field through
`?? null` — and arguably the honest shape now that
`createImportedTransactions` really does accept nulls. Recorded because it
is a public interface change that originated from a test helper's shape
rather than a product requirement.

## Test coverage gaps

None of these risks a guarantee; each is a path verified by reasoning rather
than by an executed test.

- No test covers `parseCsv`'s no-trailing-newline final-flush path
  (hand-verified correct).
- No test isolates reference-branch profile separation in `computeImportHashes`
  (`profile.id` is the first token on both branches, correct by inspection).
- No test covers `reconcile`'s `amount === 0` or non-finite validation
  branches; only the empty-hash 400 path is exercised. Note `parseStatement`
  now drops zero-amount rows, so these are defensive against a direct client
  call.
- No test isolates the in-payload same-hash dedup (`seen` set); it is a
  strict subset of what `ON CONFLICT DO NOTHING` already guarantees.
- The schema test hardcodes system category id 4 rather than looking it up;
  id 4 is a fixed seed from migration 007.

## Performance

**Category resolution does N sequential awaits**, one per distinct category
id, each costing two or three queries. A real import carries a handful of
distinct categories, so this is bounded and small — but it is sequential
where it could be batched, if an import ever spans many categories.

**`col()` re-runs `header.indexOf`** per row for the amount and direction
columns, while `dateIdx`/`descIdx`/`payeeIdx` are hoisted above the loop.
143 rows against a 16-element array; inconsistent with the file's own
pattern more than it is slow.
