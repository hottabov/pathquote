# Manager permissions: ownership and region isolation

**Date:** 2026-09-06
**Status:** Design approved, ready for implementation planning

## Problem

`MANAGER` is under-restricted. Ownership scoping (`Company.ownerId`,
`Document.authorId`) is applied broadly and works, but region is not an
enforced boundary anywhere, and several screens hand a manager data or
controls that belong to other regions:

- The product page renders a price row for **every** active region, so a
  manager reads AU, US and UK prices side by side.
- Client creation and the quote builder's client step both receive
  `listActiveRegions()`, so a manager can file a client under another
  region and legitimately quote at that region's prices.
- `createDraft` silently falls back to region `AU` (with its currency and
  tax) when the author has no region assigned.
- Admin-only Settings sections re-check the role inside each page, so a new
  sub-page under an existing section inherits no protection.
- Settings > Preferences is visible to a manager.

The requirement is absolute: a manager must not reach another manager's
clients, quotes, prices or catalogue — not through the UI, not by direct
URL, not by passing a foreign id to a server action.

## Access model

Two independent axes, applied together as AND.

### Axis 1 — ownership

`Company.ownerId` and `Document.authorId`. A manager sees only what they
created. Already implemented by `companyWhereForUser` and
`documentWhereForUser` in `src/lib/scope.ts` and applied across
`src/lib/queries/` and `src/lib/actions/`. Unchanged by this work.

### Axis 2 — region

`User.regionId`. New axis. It determines which prices a manager sees and
which region they may create clients and quotes in. The binding is hard:
region is never selectable in a manager's UI, it is derived from the
session on the server.

For companies and documents, ownership is strictly narrower than region, so
region acts as a **write** guard there (creation, re-assignment) rather than
a read filter. For prices and the catalogue, region **is** the read filter.

### Roles

| Role | Rights |
|---|---|
| `ADMIN` | Everything |
| `DEVELOPER` | Everything (identical to `ADMIN`; distinct only as the support form's addressee) |
| `MANAGER` | Own clients, own quotes, read-only catalogue at own-region prices, own account |

`isAdminRole` (`src/lib/roles.ts`) stays the single source of truth for
"is this an admin". No new role is introduced.

### Catalogue visibility

`CatalogVisibility` stays scoped per user, as it is today. It is not
re-scoped to region. See "Accepted risks" below for the consequence and the
mitigation.

### Manager with no region

A manager whose `regionId` is `null` is blocked. Only Account, PathQuote
Support and sign-out remain reachable; every other route renders "Region not
assigned — contact your administrator". This replaces the current silent
`AU` fallback in `createDraft`, which produces a quote in the wrong currency
and tax rate.

### Not-found over forbidden

A foreign id returns 404, never 403. This is already the codebase's
convention (see the comment in `src/app/(app)/not-found.tsx`). It is kept
everywhere this spec touches: a 403 confirms the object exists and turns id
enumeration into an oracle.

## Enforcement approach

Extend the existing call-site scoping pattern, backed by two safety nets.
Considered and rejected: a central scoped data layer (`forViewer(user)`
wrapping every Prisma delegate) and a Prisma client extension driven by
`AsyncLocalStorage`. Both give a stronger mechanical guarantee; both are a
large refactor of working code, and the client extension additionally hides
the rule from the call site and needs an `asSystem()` escape hatch whose
every omission is a new failure mode.

### New helpers in `src/lib/scope.ts`

Kept dependency-free (no `@/lib/db`, no `@prisma/client`), matching the rest
of the file, so they unit-test without a database.

```ts
/** A viewer whose region matters, as distinct from `ScopeUser`, whose
 *  ownership scoping does not read the region at all. */
export type RegionScopeUser = ScopeUser & { regionId: string | null };

/** The region a query should be limited to, or null for "every region". */
export function regionIdForUser(user: RegionScopeUser): string | null

/** Prisma `where` fragment restricting Price to the viewer's region. */
export function priceWhereForUser(user: RegionScopeUser): { regionId?: string }

/** Throws when a non-admin writes into a region other than their own, or
 *  has no region at all. */
export function assertRegionWritable(user: RegionScopeUser, regionId: string): void
```

`ScopeUser` itself is left alone. The ownership helpers never read a region,
and widening the shared type would break every existing `{ id, role }`
caller and test for no gain. `session.user` already carries `regionId`
(`src/types/next-auth.d.ts`), so it satisfies `RegionScopeUser` directly.

### Safety net 1 — segment-level guards

Each admin-only Settings segment gets its own `layout.tsx` calling
`requireAdmin()`:

- `settings/users`
- `settings/regions`
- `settings/preferences`
- `settings/content`
- `settings/option-conflict-groups`
- `settings/spec-images`
- `settings/import-export`

A direct URL to anything inside these 404s before a query runs, and a new
sub-page inherits the guard rather than having to remember it. The existing
per-page `notFound()` checks stay as defence in depth.

### Safety net 2 — structural test

A test asserts that every file under `src/lib/queries/` and
`src/lib/actions/` that references `db.company`, `db.document` or `db.price`
also imports from `@/lib/scope`. Exceptions live in an allowlist inside the
test, each with a comment explaining why that file cannot be scoped. A
future PR that adds an unscoped query fails CI.

## Navigation and Settings

### Main navigation

Unchanged. `NAV_ITEMS` (`src/lib/nav-items.ts`) stays a flat constant, and
both roles keep the same four entries: Documents, Clients, Catalog,
Settings. The manager restriction is not a shorter menu — it is what the
Catalog entry leads to (read-only, priced in their region only). Adding a
role parameter to `NAV_ITEMS` for a filter that removes nothing would be
machinery with no current caller.

### Settings navigation

`Preferences` moves to `adminOnly: true` in `SETTINGS_NAV_ITEMS`. A manager
is left with `Account` and `PathQuote Support`.

Account already lives at `/settings`, the area root, so clicking Settings
lands on Account directly. No routing change is needed to satisfy "opens
immediately".

### Account becomes a working screen

Today `/settings` is three read-only rows. It gains:

- **Photo.** The existing `AvatarEditor` component moves here from the
  dashboard greeting. It already calls `setUserAvatar`, which already
  re-checks server-side that the caller may write that user's avatar. One
  control in one place instead of two.
- **Password.** A new `changeOwnPassword` action in
  `src/lib/actions/users.ts`, separate from the admin-facing
  `setUserPassword`. It is guarded by `requireSession` (not `requireAdmin`)
  and writes **only** to `session.user.id` — it takes no `userId`
  parameter, so there is no id for a caller to substitute. The current
  password is not required.

Email, role and region stay read-only.

### What a manager never sees

The user list, other people's roles, and other managers' names. The
author/owner column is removed from the client and quote lists for a
manager — for them it is always themselves, and it is the one place a
foreign name could surface.

## Holes to close

1. **Foreign-region prices in the catalogue.** `toRegionPriceRows`
   (`src/lib/queries/catalog.ts`) builds one row per active region. It
   changes to take an already-filtered region list; the product page passes
   a list narrowed by `regionIdForUser`. An admin still sees every region —
   the price table is their editor.

2. **Region selector on client creation.** `/clients/new` and the client
   card pass `listActiveRegions()` into the form. For a manager the selector
   is not rendered and `regionId` is taken from the session server-side;
   `createCompany` and `updateCompany` call `assertRegionWritable`. The
   server check is the enforcement — hiding the selector is only its UI
   consequence.

3. **Same selector in the quote builder.** The document page passes
   `regions` into the client step. Same treatment.

4. **Silent `AU` fallback.** `createDraft`
   (`src/lib/actions/documents/lifecycle.ts`) resolves a null `regionId` to
   region `AU`. It throws instead, and the manager sees the "region not
   assigned" screen.

5. **Admin Settings pages guarded per page.** Replaced by the segment-level
   layouts described above.

6. **Author/owner column** removed from manager-facing lists.

### Reviewed, no change needed

- `/api/catalog/export` — already `requireAdmin`.
- `/api/uploads` — already honours an `adminOnly` flag per upload config.
- `/api/documents/[documentId]/quotation-pdf` — loads through
  `getDocumentForBuilder(session.user, …)`, already ownership-scoped.
- `/api/files/[name]` — serves only images under uuid filenames; carries no
  per-manager data.
- `Document.regionId` — set once at creation and never mutated by any
  action, so there is no path for a manager to move a quote between
  regions.

## Testing

**Unit** (no database, following `tests/scope.test.ts`): the three new
helpers across `ADMIN`, `DEVELOPER`, `MANAGER`, and `MANAGER` with a null
region.

**Structural**: the scope-import test described above.

**Integration** — "manager B against manager A's data": foreign company,
foreign quote, foreign contact, foreign document item, each passed by
direct id to the relevant server action. Expected: 404 or a throw, never a
200. Plus: manager B cannot create a company or a draft in manager A's
region, and cannot read a price outside their own region.

## Accepted risks

**Catalogue visibility stays per user.** A newly created manager therefore
sees the entire catalogue until an admin opens their card and hides what
should be hidden. This is a silent permission gap that depends on the admin
remembering.

Mitigation included in scope: the user-creation screen gains a "copy
catalogue visibility from…" picker listing managers in the same region. One
action instead of walking the whole tree by hand, so the default stops being
"sees everything".

## Out of scope

- Re-scoping `CatalogVisibility` to region (explicitly decided against).
- Any new role beyond the three that exist.
- Sharing clients or quotes between managers, and any admin-side
  re-assignment UI for ownership.
- Region-level permissions on anything other than prices and catalogue
  visibility.
