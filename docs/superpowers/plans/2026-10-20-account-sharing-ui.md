# Account Sharing Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let users see, grant, change and revoke access to an account (and leave a shared one) through a REST API and a "Sharing" dialog.

**Architecture:** Four routes under `/api/accounts/:id/shares` backed by a new `services/accountShares.ts`; SQL lives in the existing `db/queries/accountShares.ts`. Removing the creator moves `accounts.user_id`; anyone losing access hands their categorised history on that account to the owner. Frontend: a standalone `AccountSharing` dialog opened from the Accounts manager and the header settings menu.

**Tech Stack:** Express + zod + raw SQL (pg), Jest + supertest; Angular 22 standalone/OnPush/signals, Taiga UI v5, Vitest via `ng test`.

**Spec:** `docs/superpowers/specs/2026-10-20-account-sharing-ui-design.md`

## Global Constraints

- Response envelope `{ data, error }`; errors thrown as `{ statusCode, message }`.
- Levels: 1 = Read, 2 = Transactions, 3 = Co-owner; creator of a personal account = Owner (4). Only 1–3 are ever stored or accepted.
- Viewing members: level ≥ 1. Add / change / remove others: level ≥ 3. Removing yourself (leave): any level.
- Error copy, exactly: 404 `No user with this email`; 400 `Cannot share an account with yourself`; 409 `This user already has access`; 400 `Delete the account instead`; 404 `Not a member of this account`.
- Email match is exact and case-insensitive, input trimmed.
- `db/queries/*` never filter by `transactions.user_id` for access; permission checks stay in the service via `requireLevel` / `getAccountLevel` (`services/access.ts`).
- Angular: standalone, `ChangeDetectionStrategy.OnPush`, `input()/output()`, `computed()`, native control flow, reactive forms, no `ngClass`/`ngStyle`.
- Frontend tests run only via `ng test`, never bare vitest.

## Review Focus

1. A co-owner removes the creator while the creator is the only other co-owner → actor becomes owner, account turns personal for the actor (level 4); pinned in Task 3.
2. The departing member's rows used a category of a third user (related to them, not to the owner) → removal still succeeds and the path is copied into the owner's tree; pinned in Task 2 (path copy does not go through the relation check).
3. Email with different case or surrounding spaces → matches; pinned in Task 1.
4. Change/remove a user id that isn't a member → 404, nothing changes; pinned in Task 2.
5. User removes their own access from the dialog → dialog closes and the account disappears from lists without a manual refresh; pinned in Task 4.

---

## File Structure

| File | Responsibility |
|---|---|
| `backend/src/types/index.ts` | add `AccountMember` |
| `backend/src/db/queries/users.ts` | add `getUserIdByEmail` |
| `backend/src/db/queries/accountShares.ts` | member list, share CRUD, ownership move, history move SQL |
| `backend/src/services/accountShares.ts` (new) | rules: levels, creator handling, history move |
| `backend/src/routes/accounts.ts` | four `/:id/shares` routes + zod schemas |
| `backend/src/test/accountShares.test.ts` (new) | API tests |
| `frontend/src/app/models/account.ts` | `AccountMember`, `ShareLevel`, `LEVEL_LABELS` |
| `frontend/src/app/core/api.service.ts` | four share calls |
| `frontend/src/app/features/accounts/account-sharing/account-sharing.{ts,html,scss,spec.ts}` (new) | dialog |
| `frontend/src/app/features/accounts/account-dialog.service.ts` | `openSharing` |
| `frontend/src/app/features/accounts/accounts.{ts,html}`, `features/header/header.{ts,html}` | entry points |
| `CLAUDE.md` | document API + `transactions.user_id` caveat |

---

### Task 1: List members and add by email

**Files:**
- Modify: `backend/src/types/index.ts`, `backend/src/db/queries/users.ts`, `backend/src/db/queries/accountShares.ts`, `backend/src/routes/accounts.ts`
- Create: `backend/src/services/accountShares.ts`, `backend/src/test/accountShares.test.ts`

**Interfaces:**
- Produces:
  - `interface AccountMember { user_id: number; name: string; email: string; level: 1 | 2 | 3 | 4; is_creator: boolean }` (types/index.ts)
  - `getUserIdByEmail(email: string): Promise<number | null>` — `WHERE lower(email) = lower($1)`, selects only `id`.
  - `getAccountMembers(accountId: number): Promise<AccountMember[]>` — creator row from `accounts.user_id` (level 4, or 3 when any share has level 3 — same rule as `getAccessRows`) UNION share rows; order: creator first, then level desc, then `name`.
  - `insertShare(accountId: number, userId: number, level: 1 | 2 | 3): Promise<void>`
  - service `listMembers(accountId, userId): Promise<AccountMember[]>` (requires READ), `addMember(accountId, userId, email, level): Promise<AccountMember[]>` (requires ADMIN).
  - `GET /api/accounts/:id/shares`, `POST /api/accounts/:id/shares` body `{ email: string, level: 1|2|3 }`.

- [ ] **Step 1: Write failing tests** in `accountShares.test.ts`. Copy the `register`, `makeAccount`, `grant`, fetch-mock and `expenseCategoryOf` helpers from `sharing.test.ts:22-70`. Users A (creator of `acc`), B, C; set names via SQL.

```ts
it('lists the creator and shares for a level-1 member', async () => {
  await grant(acc, bId, 1);
  const res = await request(app).get(`/api/accounts/${acc}/shares`).set('Authorization', `Bearer ${tokenB}`);
  expect(res.status).toBe(200);
  expect(res.body.data).toEqual([
    { user_id: aId, name: 'Alice', email: aEmail, level: 4, is_creator: true },
    { user_id: bId, name: 'Bob', email: bEmail, level: 1, is_creator: false },
  ]);
});
it('403 listing without access', ...)            // C → 403
it('adds by email, case-insensitive and trimmed', ...) // A posts `  ${cEmail.toUpperCase()} `, level 2 → 200, C in list at 2
it('404 for unknown email', ...)                 // message 'No user with this email'
it('400 sharing with yourself', ...)             // 'Cannot share an account with yourself'
it('409 for an existing member', ...)            // B again → 'This user already has access'; creator's email → 409 too
it('403 adding at level 2', ...)                 // B (level 2) posts → 403
it('granting co-owner makes the creator level 3', ...) // after POST level 3, GET /api/accounts as A → access_level 3; list shows creator level 3
it('400 for level 4 in the body', ...)           // zod rejects
```

Each test sets up its own shares (truncate `account_shares` for `acc` in `beforeEach`).

- [ ] **Step 2: Run** `cd backend && npx jest --testPathPatterns=accountShares` — expect FAIL (404 route).
- [ ] **Step 3: Implement** queries, service, routes. Zod: `z.strictObject({ email: z.string().trim().min(1), level: z.union([z.literal(1), z.literal(2), z.literal(3)]) })`. Service order in `addMember`: `requireLevel(ADMIN)` → lookup (404) → self (400) → member already incl. creator (409) → insert → return `getAccountMembers`.
- [ ] **Step 4: Run** the same command — PASS.
- [ ] **Step 5: Commit** `feat(sharing): list account members and share by email`.

---

### Task 2: Change level, remove and leave (non-creator) with history move

**Files:**
- Modify: `backend/src/db/queries/accountShares.ts`, `backend/src/services/accountShares.ts`, `backend/src/routes/accounts.ts`, `backend/src/test/accountShares.test.ts`

**Interfaces:**
- Consumes: Task 1 queries/service; `getCategoryPath`, `findOrCreateCategoryPath` from `db/queries/categories.ts`; `withTransaction`, `Tx` from `db/index.ts`.
- Produces:
  - service `setMemberLevel(accountId, userId, targetUserId, level: 1|2|3): Promise<AccountMember[]>`, `removeMember(accountId, userId, targetUserId): Promise<AccountMember[]>` (list returned without an access check, so a leaver gets a response).
  - `moveHistoryToOwner(tx: Tx, accountId: number, fromUserId: number, ownerId: number, categoryMap: Map<number, number>): Promise<void>` in queries — updates expense/income rows of the account (`(debit_account_id = $1 AND credit_account_id IS NULL) OR (credit_account_id = $1 AND debit_account_id IS NULL)`) with `user_id = fromUserId`: sets `user_id = ownerId` and `category_id` via the map.
  - service-internal `buildCategoryMap(accountId, fromUserId, ownerId): Promise<Map<number, number>>` — distinct category ids of those rows; system (`user_id IS NULL`) or owner's own → unchanged; otherwise `findOrCreateCategoryPath(ownerId, await getCategoryPath(id))`. Deliberately **not** `resolveCategoryForOwner`: no relation check, so third-party categories (Review Focus 2) don't block removal. Runs before the transaction (copying a path is idempotent; a leftover copy after a failed removal is harmless).
  - `PUT /api/accounts/:id/shares/:userId` body `{ level }`, `DELETE /api/accounts/:id/shares/:userId`.
  - Task 3 replaces the "target is creator" branch; until then it throws 400 `Delete the account instead`.

- [ ] **Step 1: Write failing tests**

```ts
it('co-owner changes a member level', ...)          // A sets B 1→2 → list shows 2
it('403 changing or removing at level 2', ...)      // B(2) PUT/DELETE on C → 403
it('404 for a non-member target', ...)              // PUT and DELETE for C (no share) → 'Not a member of this account'
it('member leaves at level 1', ...)                 // B DELETEs self → 200; GET /api/accounts as B lacks acc
it('removing the last co-owner makes it personal again', ...) // B at 3, A removes B → A's access_level 4
it('removed member history moves to the owner', async () => {
  // B at 2 adds an expense on acc in B's category 'Food/Lunch' (via POST /api/transactions)
  // and a transfer acc → B's own account
  // A removes B
  const row = await pool.query('SELECT user_id, category_id FROM transactions WHERE id = $1', [expenseId]);
  expect(row.rows[0].user_id).toBe(aId);
  // category now belongs to A under the same path
  const cat = await pool.query('SELECT user_id, name FROM categories WHERE id = $1', [row.rows[0].category_id]);
  expect(cat.rows[0]).toEqual({ user_id: aId, name: 'Lunch' });
  // A can re-categorise it to one of A's categories: PUT /api/transactions/:id → 200
  // the transfer row keeps user_id = bId
});
it('third-party category does not block removal', ...) // B's row uses C's category (C shares an account with B); A removes B → 200, row's category owned by A
```

- [ ] **Step 2: Run** `npx jest --testPathPatterns=accountShares` — new tests FAIL.
- [ ] **Step 3: Implement.** `setMemberLevel`: ADMIN check, target must be a share row (404), update level. `removeMember`: ADMIN unless `targetUserId === userId` (then any level ≥ 1); 404 if not a member; build category map; `withTransaction`: `moveHistoryToOwner` then delete the share.
- [ ] **Step 4: Run** — PASS; then full `npm test` in `backend/`.
- [ ] **Step 5: Commit** `feat(sharing): change, revoke and leave account access`.

---

### Task 3: Creator is removed or downgraded — ownership move

**Files:**
- Modify: `backend/src/db/queries/accountShares.ts`, `backend/src/services/accountShares.ts`, `backend/src/test/accountShares.test.ts`

**Interfaces:**
- Consumes: Task 2 service and `moveHistoryToOwner`.
- Produces: `getEarliestCoOwner(accountId: number, excludeUserId: number): Promise<number | null>` (level 3 share, `ORDER BY created_at, user_id`); `transferOwnership(tx: Tx, accountId: number, newOwnerId: number): Promise<void>` (`UPDATE accounts SET user_id`, delete the new owner's share row).

Rules (target = `accounts.user_id`):
- New owner = the actor when actor ≠ creator (actor necessarily holds level 3); else `getEarliestCoOwner(acc, creator)`; `null` → 400 `Delete the account instead`.
- PUT with level 3 on the creator of a co-owned account → no-op, return list.
- PUT below 3: in one transaction `transferOwnership`, then insert a share for the old creator at the new level. No history move (they keep access).
- DELETE: build category map for (old creator → new owner) first; transaction: `transferOwnership`, `moveHistoryToOwner(old creator → new owner)`.

- [ ] **Step 1: Write failing tests**

```ts
it('co-owner removes the creator and becomes owner', ...)   // B at 3, B DELETEs A → accounts.user_id = B; A has no access; B's access_level 4
it('creator downgrades self on a co-owned account', ...)    // B at 3 (granted before C at 3); A PUTs self level 1 → owner B; A share level 1; C still 3
it('personal-account owner cannot leave or downgrade', ...) // A DELETE/PUT self → 400 'Delete the account instead'
it('creator history moves to the new owner on removal', ...) // A's categorised expense on acc → user_id B, category in B's tree
it('setting the co-owned creator to co-owner is a no-op', ...)
```

- [ ] **Step 2: Run** — FAIL.
- [ ] **Step 3: Implement** the creator branch in `setMemberLevel` / `removeMember`.
- [ ] **Step 4: Run** `npx jest --testPathPatterns=accountShares`, then `npm test` — PASS.
- [ ] **Step 5: Update `CLAUDE.md`** (Database section, after the `account_shares` paragraph): one paragraph on `/api/accounts/:id/shares` (GET ≥1, POST/PUT/DELETE ≥3, self-DELETE any level), the creator ownership move, and that when a member loses access their expense/income rows on that account are re-assigned to the owner with categories copied — so `transactions.user_id` is "who entered it, or the owner who inherited it"; also drop "permissions are granted by direct SQL for now, with no UI" from the intro.
- [ ] **Step 6: Commit** `feat(sharing): move ownership when the creator is removed`.

---

### Task 4: Frontend Sharing dialog

**Files:**
- Modify: `frontend/src/app/models/account.ts`, `frontend/src/app/core/api.service.ts`
- Create: `frontend/src/app/features/accounts/account-sharing/account-sharing.{ts,html,scss,spec.ts}`

**Interfaces:**
- Produces:
  - `type ShareLevel = 1 | 2 | 3`; `interface AccountMember { user_id: number; name: string; email: string; level: AccessLevel; is_creator: boolean }`; `const LEVEL_LABELS: Record<AccessLevel, string> = { 1: 'Read', 2: 'Transactions', 3: 'Co-owner', 4: 'Owner' }`.
  - `ApiService`: `getAccountShares(accountId)`, `addAccountShare(accountId, email: string, level: ShareLevel)`, `updateAccountShare(accountId, userId, level: ShareLevel)`, `removeAccountShare(accountId, userId)` — all `Observable<ApiResponse<AccountMember[]>>`.
  - `AccountSharing` component, context `TuiDialogContext<void, Account>` via `POLYMORPHEUS_CONTEXT` (as `AccountForm`).

Behaviour:
- Loads members on construction into `members = signal<AccountMember[]>([])`.
- `me = computed(...)` by `AuthService.user()?.id`; `canManage = computed(() => (me()?.level ?? 0) >= 3)`.
- Row: name (+ " (you)"), email, level. Managers get a `tuiSelect` of `[1,2,3]` with `LEVEL_LABELS` (Owner row shows text, no select, no ✕) and a ✕ button; others see the label only.
- Add row (managers only): reactive form `{ email: required, level: 1 }`, button Add.
- Granting 3 (add or change) while `me().level === 4` → `TUI_CONFIRM` with content `"<account name>" becomes co-owned: you will have equal rights with <name or email>.`; cancel aborts.
- "Leave account" shown when `me().level !== 4`, confirm `Leave "<account name>"? You will lose access to it.`; removing yourself via ✕ behaves the same.
- After every successful mutation: `members.set(data)`, `AccountsState.reload()`, `CategoriesState.reload()`, `TransactionsState.reload()`; after removing self → `context.completeWith()`.
- Errors → `NotificationService.showError(e, 'Failed to update sharing')`.

- [ ] **Step 1: Write failing spec** `account-sharing.spec.ts` (setup like `account-form.spec.ts`: zoneless, `provideHttpClientTesting`, mocked `TuiDialogService.open` returning `of(true)`, `POLYMORPHEUS_CONTEXT` with `completeWith: vi.fn()`, `AuthService` stub with `user` signal). Tests:
  - `renders members with level labels` — GET flushed with creator(4) + member(1) → text contains `Owner`, `Read`.
  - `hides management controls below co-owner` — me at level 2 → no Add button, no ✕, Leave shown.
  - `adds a member` — form `{ email: 'x@y', level: 2 }`, `add()` → POST body `{ email: 'x@y', level: 2 }`, members updated, `AccountsState.reload` called.
  - `confirms before granting co-owner on a personal account` — me level 4, `changeLevel(member, 3)` → dialog open called once, then PUT.
  - `leaving closes the dialog` — me level 1, `leave()` → DELETE `/api/accounts/7/shares/<myId>`, `completeWith` called.
- [ ] **Step 2: Run** `cd frontend && npx ng test --watch=false --include=src/app/features/accounts/account-sharing/account-sharing.spec.ts` — FAIL.
- [ ] **Step 3: Implement** model, API methods, component (Taiga `TuiSelect` + `TuiDataListWrapper` like `account-form.html`, `TuiInput` for email, `TuiButton` with `@tui.x` icon).
- [ ] **Step 4: Run** same command — PASS.
- [ ] **Step 5: Commit** `feat(sharing): account sharing dialog`.

---

### Task 5: Entry points

**Files:**
- Modify: `frontend/src/app/features/accounts/account-dialog.service.ts`, `accounts.ts`, `accounts.html`, `features/header/header.ts`, `header.html`, `features/accounts/account-dialog.service.spec.ts`

**Interfaces:**
- Consumes: `AccountSharing` (Task 4).
- Produces: `AccountDialogService.openSharing(account: Account): Promise<void>` — lazy `import('./account-sharing/account-sharing')`, `tuiDialog`/`dialogs.open` with `label: 'Sharing: <account name>'`, `size: 's'`, errors via `showError(e, 'Failed to open sharing')`.

- [ ] **Step 1: Write failing test** in `account-dialog.service.spec.ts`: `openSharing opens a dialog labelled with the account name` (follow the existing `openEdit` test pattern).
- [ ] **Step 2: Run** `npx ng test --watch=false --include=src/app/features/accounts/account-dialog.service.spec.ts` — FAIL.
- [ ] **Step 3: Implement** `openSharing`; `Accounts.openSharingDialog()` + a "Share" button (`@tui.users` icon) after Edit in `accounts.html`, disabled without a selection; in `header.html` a `Sharing` option (`@tui.users`) after the account-name option, calling `shareFilteredAccount()` in `header.ts`.
- [ ] **Step 4: Run** `npm test` in `frontend/` — PASS; `npm run build` — succeeds.
- [ ] **Step 5: Manual check** (dev DB `finance_db_nu`, restart the :3000 backend — it has no watch): two users; A shares an account with B at Read, changes to Co-owner, B removes A; check both users' Accounts manager sections and that A's former transactions are categorised in B's tree.
- [ ] **Step 6: Commit** `feat(sharing): open sharing from accounts manager and header menu`.
