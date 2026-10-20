# Account sharing management: API + UI

## Context

Account sharing (`account_shares`, migration 009; resolution in
`backend/src/db/queries/accountShares.ts` `getAccessRows` and
`backend/src/services/access.ts`) already works, but the existing grants came
from the legacy-data port. There is no API and no UI for viewing or changing
who has access; the frontend only knows `access_level` and `owner_name`.

The purpose (user's words): family finances, for a complete picture.
- Everyone keeps their own accounts (level 4, personal).
- Some accounts belong equally to everyone with access (level 3, co-owned),
  e.g. home cash or crypto wallets.
- Accounts that matter to the whole family can be shared at levels 1–2 with
  the family member who keeps the overall books.
Sharing is optional; users who don't need it never have to touch it.

Prior art checked: Wallet (BudgetBakers) has the same per-account model
(admin / track & read / read only / no access). Monarch and YNAB share
everything with a partner. Firefly III has no sharing.

## Goals / non-goals

Goals: view who has access to an account; add a person by email; change a
level; remove a person; leave an account shared with you.

Non-goals: groups or "family" entities, email invitations, default access to
new accounts, user directory or search, UI for the existing gaps (Edit/Delete
buttons are not gated by level today, which is out of scope here).

## Decided with the user

- **All co-owners are equal.** Anyone at level 3 can add, change or remove
  anyone, including other co-owners and the account's creator.
- **UI: a separate "Sharing" dialog.** It opens from a "Share" button in the
  Accounts manager toolbar and a "Sharing" item in the header settings menu
  for the filtered account. Changes apply immediately (no Save button).
  Users at levels 1–2 see the member list read-only, plus "Leave account".

## Rules (my calls, flagged for review)

- Level labels in the UI: 1 = **Read**, 2 = **Transactions**, 3 = **Co-owner**;
  the creator of a personal account is shown as **Owner**.
- The person is found by **exact email**, case-insensitive. Not found → 404
  "No user with this email". Sharing with yourself → 400. Already a member
  → 409 (change the level in the list instead). This leaks whether an email
  is registered, which is acceptable for a family deployment.
- **Managing** (add / change / remove others) requires level ≥ 3.
  **Viewing** the list requires level ≥ 1. **Leaving** (removing yourself)
  is allowed at any level.
- When a personal-account owner grants Co-owner, the UI confirms first:
  "the account becomes co-owned; you will have equal rights with X".
- **The creator is `accounts.user_id`, not a row in `account_shares`.**
  If the creator is removed or set below Co-owner, ownership moves:
  - acting on someone else: to the co-owner doing it;
  - the creator acting on themselves: to the earliest-granted remaining
    co-owner;
  - if there is no other co-owner (personal account), the creator can't
    leave or downgrade themselves → 400 "Delete the account instead".
  The move runs in one DB transaction: set `accounts.user_id` to the new
  owner and delete their share row; when the creator is downgraded rather
  than removed, insert a share row for them at the new level.
- When the last level-3 share disappears, the account is personal again
  for whoever is `accounts.user_id`. The resolver already does this, so no
  new code is needed.
- **History moves to the account's owner when a member loses access**
  (decided with the user). Why this is needed: a transaction's category lives
  in its author's tree (`transactions.user_id`), and `getRelatedUserIds`
  follows shares. Without the move, a removed member's categories disappear
  from the others' trees, and re-categorising their old rows fails with 403
  (`resolveCategoryForOwner` checks the author's related users).
  - When: whenever a member loses all access to the account, whether removed
    or leaving, and whether or not they are the creator. Downgrades keep
    access, so they don't trigger it.
  - What: within the same DB transaction, for expense and income rows of
    this account authored by the departing user, set `transactions.user_id`
    to the account's owner (`accounts.user_id`, after any ownership move).
    Re-point `category_id` through `resolveCategoryForOwner(categoryId,
    owner)`, which copies the category path into the owner's tree.
  - Order: do the move **before** deleting the departing user's share row,
    while the two users are still related. `resolveCategoryForOwner` uses
    the pool, so it needs a client-aware variant or call order that keeps
    everything in one transaction. How to do that is up to the builder.
  - Transfers are untouched: they have no category.
  - Trade-off: for moved rows, `transactions.user_id` no longer means "who
    entered it". Add a line to CLAUDE.md saying so.

## Backend

New routes in `backend/src/routes/accounts.ts`, using the existing `validate`
(zod) + `{data, error}` envelope pattern:

| Method | Path | Body | Level |
|---|---|---|---|
| GET | `/api/accounts/:id/shares` | — | ≥ 1 |
| POST | `/api/accounts/:id/shares` | `{ email, level: 1\|2\|3 }` | ≥ 3 |
| PUT | `/api/accounts/:id/shares/:userId` | `{ level: 1\|2\|3 }` | ≥ 3 |
| DELETE | `/api/accounts/:id/shares/:userId` | — | ≥ 3, or self |

- GET returns members, creator included:
  `{ user_id, name, email, level, is_creator }[]`. The creator's level is
  4, or 3 when co-owned (same rule as `getAccessRows`). Sorted with the
  creator first, then by level desc, then name.
- `userId` = creator on PUT/DELETE triggers the ownership move above.
- New service `backend/src/services/accountShares.ts`, using `requireLevel` /
  `getAccountLevel` from `services/access.ts`. SQL goes in the existing
  `backend/src/db/queries/accountShares.ts`, plus an email lookup that
  doesn't return `password_hash`.
- Mutations return the updated member list (same shape as GET).

## Frontend

- `models/account.ts`: `AccountMember` type and level labels.
- New `features/accounts/account-sharing/account-sharing.{ts,html,scss}`
  (standalone, OnPush, signals, reactive form for the add row), following the
  `account-form` and Taiga patterns.
  - Rows: name, email, level. For managers, a level select and a remove (✕)
    button. "(you)" marks the current user.
  - Add row: email + level select + Add.
  - "Leave account" for any non-owner member, with a confirm dialog.
  - Errors go through `NotificationService.showError`.
- `AccountDialogService.openSharing(account)`, opened from `accounts.html`
  (a "Share" button next to Edit; enabled when an account is selected) and
  from `features/header/header.html` (a "Sharing" item for the filtered
  account).
- After any change: `AccountsState.reload()`, because levels, `owner_name`
  and sections change, and a categories reload, because related users
  change. If the user removed their own access, close the dialog.

## Verification

- Backend: new `backend/src/test/accountShares.test.ts`, with helpers in the
  style of `sharing.test.ts` (`register`, `makeAccount`). Cases:
  - list visible at level 1; 403 with no access;
  - add by email: case-insensitive, 404 unknown email, 400 self, 409 duplicate;
  - 403 for a level-2 user trying to add, change or remove;
  - leaving at level 1;
  - granting level 3 makes the creator resolve to 3;
  - a co-owner removing the creator moves `accounts.user_id` to them;
  - the creator downgrading themselves on a co-owned account moves ownership
    and leaves a share row for them;
  - the owner of a personal account can't leave (400);
  - removing the last co-owner makes the account personal (level 4) again;
  - removing a member who authored categorised expenses: the rows now belong
    to the owner, their categories sit in the owner's tree under the same
    path, and the owner can re-categorise them (no 403); transfers are
    unchanged.
  Run `npx jest --testPathPatterns=accountShares`, then the full `npm test`.
- Frontend: `account-sharing.spec.ts` (renders members, hides controls below
  level 3, calls the API on add, change, remove and leave). Run with
  `npx ng test --watch=false --include=...`, then `npm test`.
- Manual: two users in the dev DB. Share an account at Read, change it to
  Co-owner, have the second user remove the first, and check the Accounts
  manager sections for both users.

After approval, this design will also be committed as
`docs/superpowers/specs/2026-10-20-account-sharing-ui-design.md`, followed by
superpowers:writing-plans.
