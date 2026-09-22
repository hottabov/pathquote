# Regional Manager Role Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a fourth role, `REGIONAL_MANAGER`, that has every MANAGER right plus full read/write access to every quote in its own region and to every client owned by a manager of that region, and show a `Salesperson` column on `/quotes` to everyone except a plain MANAGER.

**Architecture:** The role hierarchy is not a ladder in code — it is three predicates in `src/lib/roles.ts` (`isAdminRole`, `isDeveloperRole`, and the new `isRegionalManagerRole`) plus two scoping functions in `src/lib/scope.ts` (`companyWhereForUser`, `documentWhereForUser`) that every query and every mutating action already routes through. Widening those two functions is therefore the whole of the permission change: reads and writes share one filter, which is exactly what "full editing of other managers' quotes in the region" requires. `REGIONAL_MANAGER` is deliberately **not** added to `isAdminRole`, so the catalogue editor, region settings, industry rename, user administration, import/export, uploads and signed-quote deletion all stay admin-only with no per-call-site change.

The region of a **quote** is `Document.regionId`, frozen at creation from the author's own region (see `createDraft`) and indexed — so `{ regionId }` *is* "authored by someone in this region at the time" and survives an author later moving region. The region of a **client** is the region of its `owner` (`Company` deliberately has no region column — see the schema comment), so it is filtered through the relation: `{ owner: { regionId } }`. That also settles the two follow-up questions:

- **Manager leaves:** nothing new is needed. `reassignUserCompanies` (admin-only, `src/lib/actions/users.ts`) already hands a leaver's clients to another manager, and quotes deliberately keep their author. Because client scope is derived from the owner's region rather than copied onto `Company`, a reassignment inside the same region changes nothing a regional manager sees, and a reassignment across regions moves the clients to the other region's view automatically. The one rule this creates: **a deactivated leaver must keep their `regionId`** — blanking it hides their clients from their own regional manager. Task 9 writes that rule down and pins it with a test.
- **ACT import:** an imported client needs nothing but a correct `ownerId` (the PathQuote user matching the ACT owner). Region visibility then follows for free. If the importer cannot resolve an owner it must leave `ownerId` null and the row stays admin-only — never guess an owner, and never add a region column to `Company` to paper over a missing one.

**Tech Stack:** Next.js (App Router, server components + server actions), Prisma 7 / PostgreSQL, NextAuth v5 (JWT session carries `role` + `regionId`), zod, Tailwind, Vitest.

**Out of scope (decided):** a regional manager may not create clients or quotes on another manager's behalf, may not reach `/settings/users`, and gets no catalogue, region, industry or import/export rights.

**Known consequence, accepted:** because writes share the read filter, a regional manager can finalize, unfinalize, send and sign any unsigned quote in their region, and delete any DRAFT in it. Signing another manager's quote puts the *signer's* name in the AUTHOR slot — the same documented behaviour an ADMIN already has (see `signQuoteAsAuthor`).

---

## Preflight

- [ ] **Step 1: Check the working tree is clean**

Run: `git status --porcelain`
Expected: no output. If there are modified files, stop and ask Vadym whether to commit them first or work in a worktree (`superpowers:using-git-worktrees`). Do not start on top of unrelated uncommitted work.

- [ ] **Step 2: Record the current test baseline**

Run: `npx vitest run 2>&1 | tail -20`
Expected: a passing summary. Write the pass/fail counts down — every later "tests pass" claim is measured against this line.

- [ ] **Step 3: Read the two rule files end to end before touching anything**

Run: `cat src/lib/roles.ts src/lib/scope.ts`
Expected: both print. These two files are the whole permission model; the rest of the plan edits their callers.

---

## File Structure

**Created**

| File | Responsibility |
| --- | --- |
| `prisma/migrations/z49_regional_manager_role/migration.sql` | Appends `REGIONAL_MANAGER` to the `Role` enum and indexes `User.regionId` (the new client filter joins on it). |
| `tests/roles.test.ts` | Unit tests for `isAdminRole`, `isDeveloperRole`, `isRegionalManagerRole`, `canSeeSalesperson`, `roleLabel` — the file that pins "a regional manager is not an admin". |

**Modified**

| File | Change |
| --- | --- |
| `prisma/schema.prisma` | `REGIONAL_MANAGER` in `enum Role` + its explanatory comment; `@@index([regionId])` on `User`. |
| `src/lib/roles.ts` | Adds `isRegionalManagerRole`, `canSeeSalesperson`, `roleLabel`. `isAdminRole` unchanged. |
| `src/lib/scope.ts` | `ScopeUser` gains optional `regionId`; `companyWhereForUser` and `documentWhereForUser` gain a regional-manager branch and explicit return types. |
| `src/lib/queries/clients.ts` | `getCompanyDetail` passes `regionId` into its `cache()` memo key. |
| `src/lib/queries/documents-builder.ts` | `getDocumentForBuilder` passes `regionId` into its `cache()` memo key and down to the loader. |
| `src/lib/queries/documents-list.ts` | Selects the author and returns `salespersonName`. |
| `src/lib/queries/users.ts` | Role unions on `UserListItem` / `UserDetail`. |
| `src/lib/validation/users.ts` | `userRoleSchema` gains the value. |
| `src/lib/validation/finalize.ts` | `FinalizerRole` gains the value. |
| `src/components/users/user-form.tsx`, `edit-user-form.tsx` | Role `<option>` + prop type. |
| `src/components/ui-kit/status-badge.tsx` | Tone for the new role. |
| `src/components/app-shell.tsx`, `src/app/(app)/settings/users/page.tsx`, `src/app/(app)/settings/users/[userId]/page.tsx` | Render `roleLabel(role)` instead of the raw enum string. |
| `src/components/documents/quotes-list.tsx` | Optional last `Salesperson` column (table + card). |
| `src/app/(app)/quotes/page.tsx` | Builds the salesperson label, gates the column, region-aware page description. |
| `src/app/(app)/clients/page.tsx` | Region-aware page description; optional `Owner` column wiring. |
| `src/components/clients/clients-list.tsx` | Optional last `Owner` column (table + card). |
| `src/app/(app)/page.tsx` | Region-aware dashboard description. |
| `scripts/create-user.ts` | Accepts the new role. |
| `tests/scope.test.ts`, `tests/users-validation.test.ts` | New cases. |
| `docs/reference/` (new note) | The leaver / ACT-import rules above. |

---

## Task 1: Role enum, migration, and the role predicates

**Files:**
- Modify: `prisma/schema.prisma:22-26` (the `Role` enum) and the `User` model (`prisma/schema.prisma:251-272`)
- Create: `prisma/migrations/z49_regional_manager_role/migration.sql`
- Modify: `src/lib/roles.ts`
- Test: `tests/roles.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/roles.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  isAdminRole,
  isDeveloperRole,
  isRegionalManagerRole,
  canSeeSalesperson,
  roleLabel,
} from "../src/lib/roles";

describe("isAdminRole", () => {
  it("is true for ADMIN and DEVELOPER", () => {
    expect(isAdminRole("ADMIN")).toBe(true);
    expect(isAdminRole("DEVELOPER")).toBe(true);
  });

  // The single most important assertion in this file. A REGIONAL_MANAGER is a
  // manager with a wider view, not a junior admin: the catalogue editor,
  // region settings, industry renames, user administration, import/export,
  // uploads and signed-quote deletion are all gated on `isAdminRole` at their
  // own call sites, and every one of them must stay shut.
  it("is false for REGIONAL_MANAGER — the wider read scope grants no admin rights", () => {
    expect(isAdminRole("REGIONAL_MANAGER")).toBe(false);
  });

  it("is false for MANAGER, an unknown role, null and undefined", () => {
    expect(isAdminRole("MANAGER")).toBe(false);
    expect(isAdminRole("SUPERADMIN")).toBe(false);
    expect(isAdminRole(null)).toBe(false);
    expect(isAdminRole(undefined)).toBe(false);
  });
});

describe("isDeveloperRole", () => {
  it("is true for DEVELOPER only", () => {
    expect(isDeveloperRole("DEVELOPER")).toBe(true);
    expect(isDeveloperRole("ADMIN")).toBe(false);
    expect(isDeveloperRole("REGIONAL_MANAGER")).toBe(false);
    expect(isDeveloperRole("MANAGER")).toBe(false);
  });
});

describe("isRegionalManagerRole", () => {
  it("is true for REGIONAL_MANAGER only", () => {
    expect(isRegionalManagerRole("REGIONAL_MANAGER")).toBe(true);
    expect(isRegionalManagerRole("MANAGER")).toBe(false);
    expect(isRegionalManagerRole("ADMIN")).toBe(false);
    expect(isRegionalManagerRole("DEVELOPER")).toBe(false);
    expect(isRegionalManagerRole(null)).toBe(false);
    expect(isRegionalManagerRole(undefined)).toBe(false);
  });
});

describe("canSeeSalesperson", () => {
  it("is true for every role that can see more than its own quotes", () => {
    expect(canSeeSalesperson("ADMIN")).toBe(true);
    expect(canSeeSalesperson("DEVELOPER")).toBe(true);
    expect(canSeeSalesperson("REGIONAL_MANAGER")).toBe(true);
  });

  // A MANAGER only ever sees their own quotes, so the column would be one
  // name repeated down the page.
  it("is false for MANAGER", () => {
    expect(canSeeSalesperson("MANAGER")).toBe(false);
  });

  // Allow-set, not deny-set: an unrecognised role gets the narrow view.
  it("is false for an unknown role, null and undefined", () => {
    expect(canSeeSalesperson("SUPERADMIN")).toBe(false);
    expect(canSeeSalesperson(null)).toBe(false);
    expect(canSeeSalesperson(undefined)).toBe(false);
  });
});

describe("roleLabel", () => {
  it("renders each known role in sentence case", () => {
    expect(roleLabel("ADMIN")).toBe("Admin");
    expect(roleLabel("MANAGER")).toBe("Manager");
    expect(roleLabel("REGIONAL_MANAGER")).toBe("Regional manager");
    expect(roleLabel("DEVELOPER")).toBe("Developer");
  });

  // A badge must never render empty: an unknown value prints itself.
  it("falls back to the raw value for an unknown role, and to an empty string for nothing", () => {
    expect(roleLabel("SUPERADMIN")).toBe("SUPERADMIN");
    expect(roleLabel(null)).toBe("");
    expect(roleLabel(undefined)).toBe("");
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/roles.test.ts`
Expected: FAIL — `"isRegionalManagerRole" is not exported by "src/lib/roles.ts"` (the whole file fails to import).

- [ ] **Step 3: Add the three functions to `src/lib/roles.ts`**

Append to the end of `src/lib/roles.ts` (leave `isAdminRole` and `isDeveloperRole` exactly as they are):

```ts
/**
 * True for REGIONAL_MANAGER only.
 *
 * A REGIONAL_MANAGER has every MANAGER right, plus a read AND write scope
 * widened from "my own rows" to "my region's rows" — every quote whose
 * `Document.regionId` is their region, and every client owned by a user of
 * their region. That widening lives entirely in `companyWhereForUser` and
 * `documentWhereForUser` (src/lib/scope.ts), which every query and every
 * mutating action already routes through, so this predicate has exactly two
 * callers there and needs none elsewhere.
 *
 * Deliberately NOT folded into `isAdminRole`. The rights gated on that
 * predicate are cross-region and structural — editing the catalogue,
 * creating regions and industries, administering users, importing/exporting,
 * uploading files, deleting a signed quote — and a regional manager has none
 * of them. Adding this role to `isAdminRole` would hand over all of them at
 * once, silently, at some thirty call sites.
 *
 * Same dependency-free, bare-`string` style as its two siblings above, for
 * the same reason: importable from pure validation modules and their tests
 * with no Prisma import.
 */
export function isRegionalManagerRole(role: string | null | undefined): boolean {
  return role === "REGIONAL_MANAGER";
}

/** Roles whose /quotes list can contain quotes written by more than one
 * person, and which therefore need the Salesperson column to tell them
 * apart. An allow-set rather than "everyone except MANAGER" so an
 * unrecognised role gets the narrow list, not a column of other people's
 * names. */
const SALESPERSON_COLUMN_ROLES: ReadonlySet<string> = new Set([
  "ADMIN",
  "DEVELOPER",
  "REGIONAL_MANAGER",
]);

/**
 * Whether the /quotes list should render its `Salesperson` column for this
 * role. True for ADMIN, DEVELOPER and REGIONAL_MANAGER; false for MANAGER,
 * whose list is their own quotes and nothing else, so the column would be
 * one name repeated down the page.
 *
 * This is a presentation rule, not an authorization one — the rows a viewer
 * gets are decided by `documentWhereForUser` (src/lib/scope.ts), and a
 * MANAGER's rows are all their own whether or not this returns true. It
 * lives here rather than in the page so the same question has one answer if
 * the clients list ever asks it too.
 */
export function canSeeSalesperson(role: string | null | undefined): boolean {
  return role != null && SALESPERSON_COLUMN_ROLES.has(role);
}

/** Role names as a person should read them, for the badges in the app shell
 * and the users list. Raw enum values leaked into the UI acceptably while
 * every one of them was a single word; `REGIONAL_MANAGER` is where that
 * stops. An unknown value prints itself rather than nothing, so a badge is
 * never blank. */
const ROLE_LABELS: Readonly<Record<string, string>> = {
  ADMIN: "Admin",
  MANAGER: "Manager",
  REGIONAL_MANAGER: "Regional manager",
  DEVELOPER: "Developer",
};

export function roleLabel(role: string | null | undefined): string {
  if (role == null) return "";
  return ROLE_LABELS[role] ?? role;
}
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/roles.test.ts`
Expected: PASS, all cases green.

- [ ] **Step 5: Add the enum value to the schema**

In `prisma/schema.prisma`, replace the `Role` enum (currently lines 22-26):

```prisma
enum Role {
  ADMIN
  MANAGER
  DEVELOPER
}
```

with:

```prisma
enum Role {
  ADMIN
  MANAGER
  REGIONAL_MANAGER
  DEVELOPER
}
```

Then, immediately above the `enum Role` line and below the existing DEVELOPER comment block, add:

```prisma
// REGIONAL_MANAGER is a MANAGER whose scope is their region rather than their
// own rows: every quote with this `regionId`, and every client owned by a user
// of this region. It is NOT an admin -- see `isRegionalManagerRole`,
// src/lib/roles.ts, for why it is deliberately absent from `isAdminRole`.
//
// Listed between MANAGER and DEVELOPER for readability only. Postgres orders
// enum values by the order they were added, not by their position in this
// block, and `ALTER TYPE ... ADD VALUE` appends -- so the database's own
// ordering is ADMIN, MANAGER, DEVELOPER, REGIONAL_MANAGER. Nothing in this app
// sorts or compares roles ordinally (every check is a set membership test in
// src/lib/roles.ts), so the divergence is cosmetic. Do not introduce a
// `role >` comparison anywhere without reading this paragraph first.
```

- [ ] **Step 6: Index `User.regionId`**

In `prisma/schema.prisma`, in `model User`, replace the closing lines:

```prisma
  supportMessages   SupportMessage[]
  catalogImports    CatalogImport[]
}
```

with:

```prisma
  supportMessages   SupportMessage[]
  catalogImports    CatalogImport[]

  // A regional manager's client list filters companies through their owner's
  // region (`companyWhereForUser`, src/lib/scope.ts: `{ owner: { regionId } }`),
  // which is the first query in this app to select users BY region. Company is
  // small and `ownerId` is indexed, so this is not today's bottleneck -- it is
  // here because the join exists at all now, and an unindexed relation filter
  // on a table that grows with headcount is the kind of thing nobody notices
  // until it is a support ticket.
  @@index([regionId])
}
```

- [ ] **Step 7: Write the migration**

Create `prisma/migrations/z49_regional_manager_role/migration.sql`:

```sql
-- Adds REGIONAL_MANAGER to the Role enum: a MANAGER whose read and write
-- scope is their whole region (every Document with that regionId, every
-- Company owned by a user of that region) instead of just their own rows.
-- It carries NO admin rights -- see isRegionalManagerRole, src/lib/roles.ts.
--
-- Postgres can append a value to an enum type but can never drop one (the
-- same constraint z23_developer_role documents), so if this role is ever
-- retired the fix is to stop assigning it, not to remove it from the type.
-- The value is appended here and listed between MANAGER and DEVELOPER in
-- schema.prisma for readability; the two orderings differ and nothing in the
-- app compares roles ordinally.
ALTER TYPE "Role" ADD VALUE 'REGIONAL_MANAGER';

-- A regional manager's client list filters Company through its owner's
-- region, which is the first query here to select User BY region.
CREATE INDEX "User_regionId_idx" ON "User"("regionId");
```

- [ ] **Step 8: Verify the migration matches the schema, and regenerate the client**

This step is Vadym's to run on his own machine — `prisma generate` fails in the sandbox mount with `EPERM: operation not permitted, unlink node_modules/.prisma/client/client.d.ts`, and the sandbox cannot reach the database at all. Stop the dev server first, or the unlink fails on macOS too.

Run (Vadym, in the repo root):

```bash
npx prisma migrate deploy
rm -rf node_modules/.prisma/client && npx prisma generate
```

Expected: `migrate deploy` reports `z49_regional_manager_role` applied; `prisma generate` reports `Generated Prisma Client`. Then confirm the enum landed in both places:

```bash
node -e "const {Role}=require('@prisma/client');console.log(Object.keys(Role))"
```

Expected: `[ 'ADMIN', 'MANAGER', 'DEVELOPER', 'REGIONAL_MANAGER' ]`.

**Until this step is done, `npx tsc --noEmit` will report `Type '"REGIONAL_MANAGER"' is not assignable to type 'Role'` and similar at every site that names the new value. Those errors are the stale generated client, not the code. `npx vitest run` and `npx eslint` are unaffected and are the usable verification in the meantime.**

- [ ] **Step 9: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/z49_regional_manager_role/migration.sql src/lib/roles.ts tests/roles.test.ts
git commit -m "feat: add REGIONAL_MANAGER role, its predicates and its migration

The role predicates and the enum only. Nothing reads the new value yet --
scope.ts widens in the next commit.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011xz3fCTvKZWdeWNKoMNdLU"
```

---

## Task 2: Widen the two scoping functions

This is the permission change. Everything before it is plumbing and everything after is presentation.

**Files:**
- Modify: `src/lib/scope.ts:11-25` (the `ScopeUser` type and both functions)
- Test: `tests/scope.test.ts`

- [ ] **Step 1: Write the failing tests**

Replace the whole of `tests/scope.test.ts` with:

```ts
import { describe, it, expect } from "vitest";
import { companyWhereForUser, documentWhereForUser } from "../src/lib/scope";

describe("companyWhereForUser", () => {
  it("returns no restriction for an ADMIN", () => {
    expect(companyWhereForUser({ id: "u1", role: "ADMIN" })).toEqual({});
  });

  it("returns no restriction for a DEVELOPER, same as an ADMIN", () => {
    expect(companyWhereForUser({ id: "u1", role: "DEVELOPER" })).toEqual({});
  });

  it("restricts to ownerId for a MANAGER", () => {
    expect(companyWhereForUser({ id: "u1", role: "MANAGER" })).toEqual({ ownerId: "u1" });
  });

  it("restricts to ownerId for any non-admin role", () => {
    expect(companyWhereForUser({ id: "u2", role: "SOMETHING_ELSE" })).toEqual({ ownerId: "u2" });
  });

  // Company has no region column of its own, deliberately (see the schema
  // comment on `model Company`). A client belongs to the manager who looks
  // after it, so "this region's clients" can only mean "owned by a user of
  // this region" -- which also means a company with no owner is invisible to
  // a regional manager, and stays admin-only. That is intended.
  it("restricts a REGIONAL_MANAGER to companies owned by a user of their region", () => {
    expect(
      companyWhereForUser({ id: "u3", role: "REGIONAL_MANAGER", regionId: "r-au" })
    ).toEqual({ owner: { regionId: "r-au" } });
  });

  it("does not also restrict a REGIONAL_MANAGER to their own companies", () => {
    const where = companyWhereForUser({ id: "u3", role: "REGIONAL_MANAGER", regionId: "r-au" });
    expect(where).not.toHaveProperty("ownerId");
  });

  // Fail closed, exactly as `priceWhereForUser` does: an empty region id is
  // an id no row can hold, so the list is empty rather than everything.
  it("restricts a region-less REGIONAL_MANAGER to a region id that matches nothing", () => {
    expect(companyWhereForUser({ id: "u4", role: "REGIONAL_MANAGER", regionId: null })).toEqual({
      owner: { regionId: "" },
    });
    expect(companyWhereForUser({ id: "u4", role: "REGIONAL_MANAGER" })).toEqual({
      owner: { regionId: "" },
    });
  });
});

describe("documentWhereForUser", () => {
  it("returns no restriction for an ADMIN", () => {
    expect(documentWhereForUser({ id: "u1", role: "ADMIN" })).toEqual({});
  });

  it("returns no restriction for a DEVELOPER, same as an ADMIN", () => {
    expect(documentWhereForUser({ id: "u1", role: "DEVELOPER" })).toEqual({});
  });

  it("restricts to authorId for a MANAGER", () => {
    expect(documentWhereForUser({ id: "u1", role: "MANAGER" })).toEqual({ authorId: "u1" });
  });

  it("restricts to authorId for any non-admin role", () => {
    expect(documentWhereForUser({ id: "u2", role: "SOMETHING_ELSE" })).toEqual({ authorId: "u2" });
  });

  // `Document.regionId` is frozen at creation from the author's own region
  // (see `createDraft`, src/lib/actions/documents/lifecycle.ts), so filtering
  // on it IS "written by someone who was in this region then" -- and it keeps
  // a quote with the region whose books it belongs to even after its author
  // moves. It is also the indexed column (`@@index([regionId, status])`),
  // where `author: { regionId }` would be a join.
  it("restricts a REGIONAL_MANAGER to their region's quotes", () => {
    expect(
      documentWhereForUser({ id: "u3", role: "REGIONAL_MANAGER", regionId: "r-au" })
    ).toEqual({ regionId: "r-au" });
  });

  it("does not also restrict a REGIONAL_MANAGER to their own quotes", () => {
    const where = documentWhereForUser({ id: "u3", role: "REGIONAL_MANAGER", regionId: "r-au" });
    expect(where).not.toHaveProperty("authorId");
  });

  it("restricts a region-less REGIONAL_MANAGER to a region id that matches nothing", () => {
    expect(documentWhereForUser({ id: "u4", role: "REGIONAL_MANAGER", regionId: null })).toEqual({
      regionId: "",
    });
    expect(documentWhereForUser({ id: "u4", role: "REGIONAL_MANAGER" })).toEqual({ regionId: "" });
  });

  // The filter is shared by reads and writes -- every mutating action spreads
  // it into its own `where` (see src/lib/actions/documents/*.ts). This test
  // exists to state that in the test file rather than only in a comment: a
  // regional manager editing a colleague's draft is the intended behaviour,
  // not an oversight, and narrowing this function later silently removes it.
  it("gives a REGIONAL_MANAGER the same filter for a write as for a read", () => {
    const user = { id: "u3", role: "REGIONAL_MANAGER", regionId: "r-au" };
    expect(documentWhereForUser(user)).toEqual(documentWhereForUser({ ...user }));
    expect(documentWhereForUser(user)).toEqual({ regionId: "r-au" });
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run tests/scope.test.ts`
Expected: FAIL — the REGIONAL_MANAGER cases report `{ ownerId: 'u3' }` / `{ authorId: 'u3' }` where `{ owner: { regionId: 'r-au' } }` / `{ regionId: 'r-au' }` was expected. The MANAGER and ADMIN cases pass.

- [ ] **Step 3: Widen `ScopeUser` and both functions**

In `src/lib/scope.ts`, replace the header comment and the block from `export type ScopeUser` through the end of `documentWhereForUser` (currently lines 1-25):

```ts
// Pure scoping helpers: given the current user (id + role), return the
// Prisma `where` fragment that restricts a query to what that user is
// allowed to see. ADMIN (and DEVELOPER — see isAdminRole) sees everything
// (an empty filter); MANAGER is restricted to their own companies/documents
// (spec §6). Kept dependency free (no `@/lib/db` import) so these are
// trivially unit-testable and safe to import from both server
// actions/queries and plain tests.

import { isAdminRole } from "./roles";

export type ScopeUser = { id: string; role: string };

/** Restricts a Company query to companies owned by `user`, or `{}` (no
 * restriction) for an admin. Spread this into a Prisma `where` object,
 * merging with any other filters (e.g. a search term) the caller applies. */
export function companyWhereForUser(user: ScopeUser): { ownerId?: string } {
  if (isAdminRole(user.role)) return {};
  return { ownerId: user.id };
}

/** Restricts a Document query to documents authored by `user`, or `{}` (no
 * restriction) for an admin. */
export function documentWhereForUser(user: ScopeUser): { authorId?: string } {
  if (isAdminRole(user.role)) return {};
  return { authorId: user.id };
}
```

with:

```ts
// Pure scoping helpers: given the current user (id + role + region), return
// the Prisma `where` fragment that restricts a query to what that user is
// allowed to see. ADMIN (and DEVELOPER — see isAdminRole) sees everything
// (an empty filter); REGIONAL_MANAGER sees their whole region;
// MANAGER is restricted to their own companies/documents (spec §6). Kept
// dependency free (no `@/lib/db` import) so these are trivially
// unit-testable and safe to import from both server actions/queries and
// plain tests.
//
// These two functions are the app's read AND write boundary: every query
// spreads one of them into its `where`, and so does every mutating action
// (see src/lib/actions/documents/*.ts, src/lib/actions/clients.ts), which
// load the row they are about to change through the same filter. Widening a
// filter therefore widens editing too, and that is deliberate for
// REGIONAL_MANAGER — it may edit, finalize, unfinalize and delete drafts in
// its region, decided by Vadym 2026-09-22. Anything a regional manager must
// NOT do is gated on `isAdminRole` at its own call site, not here.

import { isAdminRole, isRegionalManagerRole } from "./roles";

/** A viewer whose rows are being scoped. `regionId` is optional so every
 * existing `{ id, role }` caller and test still type-checks; it is read only
 * for a REGIONAL_MANAGER, and a missing one fails closed (see below). A
 * NextAuth `session.user` satisfies this directly — see
 * src/types/next-auth.d.ts. */
export type ScopeUser = { id: string; role: string; regionId?: string | null };

/** What `companyWhereForUser` may return: an owner id (MANAGER), an owner
 * region (REGIONAL_MANAGER), or nothing at all (admin). Named so the union
 * is visible at the call sites that spread it. */
export type CompanyScopeWhere = { ownerId?: string; owner?: { regionId: string } };

/** What `documentWhereForUser` may return — see `CompanyScopeWhere`. */
export type DocumentScopeWhere = { authorId?: string; regionId?: string };

/** The region id to scope a regional manager by, or `""` when they have
 * none — an id no row can hold, so the query returns nothing rather than
 * everything. Same fail-closed choice `priceWhereForUser` makes below, for
 * the same reason: a missed routing guard should leak an empty list, not
 * another region's rows. `??` and not `||` deliberately (see
 * `priceRegionIdForUser`'s comment). */
function regionalScopeId(user: ScopeUser): string {
  return user.regionId ?? "";
}

/** Restricts a Company query to what `user` may see: every company for an
 * admin (`{}`), every company owned by a user of their region for a
 * REGIONAL_MANAGER, and their own companies for everyone else. Spread this
 * into a Prisma `where` object, merging with any other filters (e.g. a
 * search term) the caller applies.
 *
 * A regional manager's filter goes through the `owner` relation because
 * `Company` deliberately has no region of its own (see the comment on
 * `model Company` in prisma/schema.prisma): a client belongs to the business
 * and to the manager who looks after them, not to an office — an Australian
 * manager sells into Europe and that European buyer is still their client.
 * So "this region's clients" can only mean "owned by a user of this region",
 * and two consequences follow, both intended:
 *   - a company with no owner (`ownerId` null) matches no regional manager
 *     and stays admin-only;
 *   - handing a leaver's clients to another manager (`reassignUserCompanies`,
 *     src/lib/actions/users.ts) moves them between regional views
 *     automatically, with no second column to keep in step — but blanking a
 *     departed manager's own `regionId` hides their clients from their
 *     region's manager. Deactivate the account; leave its region alone.
 */
export function companyWhereForUser(user: ScopeUser): CompanyScopeWhere {
  if (isAdminRole(user.role)) return {};
  if (isRegionalManagerRole(user.role)) return { owner: { regionId: regionalScopeId(user) } };
  return { ownerId: user.id };
}

/** Restricts a Document query to what `user` may see: every quote for an
 * admin (`{}`), every quote in their region for a REGIONAL_MANAGER, and
 * their own for everyone else.
 *
 * A regional manager is scoped on `Document.regionId`, not on
 * `author: { regionId }`. The two almost always agree — `createDraft`
 * (src/lib/actions/documents/lifecycle.ts) sets a new quote's region from
 * the author's own and nothing ever changes it — and where they disagree,
 * this one is right: the column is frozen at creation, so a quote stays with
 * the region whose currency, tax and discount caps it was priced under even
 * after its author moves offices. It is also the indexed column
 * (`@@index([regionId, status])`) where the relation form would be a join.
 */
export function documentWhereForUser(user: ScopeUser): DocumentScopeWhere {
  if (isAdminRole(user.role)) return {};
  if (isRegionalManagerRole(user.role)) return { regionId: regionalScopeId(user) };
  return { authorId: user.id };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/scope.test.ts tests/region-scope.test.ts`
Expected: PASS for both files. `region-scope.test.ts` must stay green untouched — `RegionScopeUser` is `ScopeUser & { regionId: string | null }`, and intersecting a required `regionId` over the new optional one leaves it required, so `regionIdForUser` / `priceWhereForUser` / `assertRegionWritable` are unaffected.

- [ ] **Step 5: Run the whole suite and the linter**

Run: `npx vitest run 2>&1 | tail -20 && npx eslint`
Expected: the same pass count as the Preflight baseline plus the new cases; no eslint output.

- [ ] **Step 6: Commit**

```bash
git add src/lib/scope.ts tests/scope.test.ts
git commit -m "feat: scope a regional manager to their region's quotes and clients

Quotes filter on the frozen Document.regionId; clients filter through the
owner's region, since Company deliberately has none. Both fail closed for a
region-less viewer. The filter is shared by reads and writes, so this is
also what lets a regional manager edit a colleague's draft.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011xz3fCTvKZWdeWNKoMNdLU"
```

---

## Task 3: Carry the region into the two `cache()` memo keys

Two reads rebuild a `ScopeUser` from primitives inside a `cache()` boundary, because React's `cache` matches object arguments by identity and every `auth()` call hands back a fresh `session.user`. Both now drop the region on the floor, which would show a regional manager a 404 for a colleague's quote while the list links to it.

**Files:**
- Modify: `src/lib/queries/clients.ts:102-121`
- Modify: `src/lib/queries/documents-builder.ts:577-612`

- [ ] **Step 1: Find every memo that rebuilds a ScopeUser, so none is missed**

Run: `grep -rn "ScopeUser = { id" src/lib`
Expected: exactly two hits — `src/lib/queries/clients.ts` and `src/lib/queries/documents-builder.ts`. If a third appears, it needs the same edit; add it to this task before continuing.

- [ ] **Step 2: Fix `getCompanyDetail`**

In `src/lib/queries/clients.ts`, replace:

```ts
export function getCompanyDetail(
  user: ScopeUser,
  companyId: string
): Promise<CompanyDetail | null> {
  return getCompanyDetailInScope(user.id, user.role, companyId);
}

/** Takes the scope as its two primitive parts rather than the `ScopeUser`
 * itself, for the reason `getDocumentForBuilderInScope`
 * (src/lib/queries/documents.ts) spells out: React's `cache` matches object
 * arguments by identity, and every `auth()` call hands back a fresh
 * `session.user`, so a memo keyed on that object would never hit. */
const getCompanyDetailInScope = cache(async function getCompanyDetailInScope(
  userId: string,
  role: string,
  companyId: string
): Promise<CompanyDetail | null> {
  const user: ScopeUser = { id: userId, role };
```

with:

```ts
export function getCompanyDetail(
  user: ScopeUser,
  companyId: string
): Promise<CompanyDetail | null> {
  return getCompanyDetailInScope(user.id, user.role, user.regionId ?? null, companyId);
}

/** Takes the scope as its three primitive parts rather than the `ScopeUser`
 * itself, for the reason `getDocumentForBuilderInScope`
 * (src/lib/queries/documents.ts) spells out: React's `cache` matches object
 * arguments by identity, and every `auth()` call hands back a fresh
 * `session.user`, so a memo keyed on that object would never hit.
 *
 * `regionId` is one of them because it shapes the query: a REGIONAL_MANAGER
 * is scoped by their region rather than their own id
 * (`companyWhereForUser`). Dropping it here would resolve every colleague's
 * client to `null` — a 404 on a company the list had just linked to. */
const getCompanyDetailInScope = cache(async function getCompanyDetailInScope(
  userId: string,
  role: string,
  regionId: string | null,
  companyId: string
): Promise<CompanyDetail | null> {
  const user: ScopeUser = { id: userId, role, regionId };
```

- [ ] **Step 3: Fix `getDocumentForBuilder`**

In `src/lib/queries/documents-builder.ts`, replace:

```ts
export function getDocumentForBuilder(
  user: ScopeUser,
  id: string,
  tx?: Prisma.TransactionClient
): Promise<DocumentForBuilder | null> {
  return tx ? loadDocumentForBuilder(user.id, user.role, id, tx) : getDocumentForBuilderInScope(user.id, user.role, id);
}
```

with:

```ts
export function getDocumentForBuilder(
  user: ScopeUser,
  id: string,
  tx?: Prisma.TransactionClient
): Promise<DocumentForBuilder | null> {
  const regionId = user.regionId ?? null;
  return tx
    ? loadDocumentForBuilder(user.id, user.role, regionId, id, tx)
    : getDocumentForBuilderInScope(user.id, user.role, regionId, id);
}
```

Then replace:

```ts
/** Memoization boundary for `getDocumentForBuilder` above, taking the scope
 * as its two primitive parts rather than the `ScopeUser` itself: React's
 * `cache` matches object arguments by identity, and each `auth()` call
 * deserializes a fresh `session.user`, so a `ScopeUser` parameter would miss
 * on every call and quietly memoize nothing. Both parts are part of the key
 * because both shape the query — `documentWhereForUser` reads the role to
 * decide whether the id restricts anything at all. */
const getDocumentForBuilderInScope = cache(function getDocumentForBuilderInScope(
  userId: string,
  role: string,
  id: string
): Promise<DocumentForBuilder | null> {
  return loadDocumentForBuilder(userId, role, id);
});
```

with:

```ts
/** Memoization boundary for `getDocumentForBuilder` above, taking the scope
 * as its three primitive parts rather than the `ScopeUser` itself: React's
 * `cache` matches object arguments by identity, and each `auth()` call
 * deserializes a fresh `session.user`, so a `ScopeUser` parameter would miss
 * on every call and quietly memoize nothing. All three parts are part of the
 * key because all three shape the query — `documentWhereForUser` reads the
 * role to decide WHICH column restricts the read (`authorId` for a manager,
 * `regionId` for a regional manager, neither for an admin) and then reads
 * that column's value. */
const getDocumentForBuilderInScope = cache(function getDocumentForBuilderInScope(
  userId: string,
  role: string,
  regionId: string | null,
  id: string
): Promise<DocumentForBuilder | null> {
  return loadDocumentForBuilder(userId, role, regionId, id);
});
```

Then replace:

```ts
async function loadDocumentForBuilder(
  userId: string,
  role: string,
  id: string,
  tx?: Prisma.TransactionClient
): Promise<DocumentForBuilder | null> {
  const client = tx ?? db;
  const user: ScopeUser = { id: userId, role };
```

with:

```ts
async function loadDocumentForBuilder(
  userId: string,
  role: string,
  regionId: string | null,
  id: string,
  tx?: Prisma.TransactionClient
): Promise<DocumentForBuilder | null> {
  const client = tx ?? db;
  const user: ScopeUser = { id: userId, role, regionId };
```

- [ ] **Step 4: Verify nothing else calls the loader with the old arity**

Run: `grep -rn "loadDocumentForBuilder\|getDocumentForBuilderInScope\|getCompanyDetailInScope" src`
Expected: only the definitions and the call sites just edited — 3 hits in `documents-builder.ts`, 2 in `clients.ts`. Any other hit is a call that still passes the old argument list and must be updated the same way.

- [ ] **Step 5: Lint and test**

Run: `npx eslint src/lib/queries && npx vitest run 2>&1 | tail -10`
Expected: no eslint output; the suite at its Task-2 pass count.

- [ ] **Step 6: Commit**

```bash
git add src/lib/queries/clients.ts src/lib/queries/documents-builder.ts
git commit -m "fix: key the company and document memos on the viewer's region

Both cache() boundaries rebuild a ScopeUser from primitives, and both dropped
regionId -- which after the scope change would 404 a regional manager on a
colleague's quote the list had just linked to.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011xz3fCTvKZWdeWNKoMNdLU"
```

---

## Task 4: Let the role be assigned — validation, types and the two forms

**Files:**
- Modify: `src/lib/validation/users.ts:52`
- Modify: `src/lib/validation/finalize.ts:29`
- Modify: `src/lib/queries/users.ts:8` and `:49`
- Modify: `src/components/users/user-form.tsx:112-114`
- Modify: `src/components/users/edit-user-form.tsx:12` and `:95-97`
- Modify: `scripts/create-user.ts`
- Test: `tests/users-validation.test.ts:55-67`

- [ ] **Step 1: Write the failing test**

In `tests/users-validation.test.ts`, replace:

```ts
describe("userRoleSchema", () => {
  accepts(userRoleSchema, [
    ["ADMIN", "ADMIN"],
    ["MANAGER", "MANAGER"],
    ["DEVELOPER", "DEVELOPER"],
  ]);

  rejects(userRoleSchema, [
    ["a role that isn't one of the known ones", "SUPERADMIN"],
    ["a blank role", ""],
  ]);
});
```

with:

```ts
describe("userRoleSchema", () => {
  accepts(userRoleSchema, [
    ["ADMIN", "ADMIN"],
    ["MANAGER", "MANAGER"],
    ["REGIONAL_MANAGER", "REGIONAL_MANAGER"],
    ["DEVELOPER", "DEVELOPER"],
  ]);

  rejects(userRoleSchema, [
    ["a role that isn't one of the known ones", "SUPERADMIN"],
    ["the role name as a person reads it, not the enum value", "Regional manager"],
    ["a blank role", ""],
  ]);
});

// `canModifyUser` protects the last account with admin rights. REGIONAL_MANAGER
// is not one of those (`isAdminRole` is false for it), so demoting the last
// admin to it must be refused exactly like a demotion to MANAGER -- otherwise
// the new role is a back door to an admin-less system.
describe("canModifyUser and the new role", () => {
  it("refuses demoting the last active admin to REGIONAL_MANAGER", () => {
    const target = { id: "user-admin", role: "ADMIN" as const, active: true };
    const result = canModifyUser("some-other-admin", target, { role: "REGIONAL_MANAGER" }, 1);
    expect(result).toBe("Can't demote the last active admin");
  });

  it("refuses an admin stripping their own rights by becoming a REGIONAL_MANAGER", () => {
    const target = { id: "user-admin", role: "ADMIN" as const, active: true };
    const result = canModifyUser(target.id, target, { role: "REGIONAL_MANAGER" }, 5);
    expect(result).toBe("You can't remove your own admin role");
  });

  it("allows promoting a MANAGER to REGIONAL_MANAGER", () => {
    const target = { id: "user-manager", role: "MANAGER" as const, active: true };
    expect(canModifyUser("some-admin", target, { role: "REGIONAL_MANAGER" }, 3)).toBeNull();
  });
});
```

Check the file's existing imports include `canModifyUser` (it does — the `canModifyUser` describe block further down uses it). If the new block sits above that import, move it below; do not add a duplicate import.

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/users-validation.test.ts`
Expected: FAIL — `REGIONAL_MANAGER` is rejected by `userRoleSchema`, and the three `canModifyUser` cases fail to type-check or fail outright.

- [ ] **Step 3: Widen the zod enum**

In `src/lib/validation/users.ts`, replace:

```ts
export const userRoleSchema = z.enum(["ADMIN", "MANAGER", "DEVELOPER"]);
```

with:

```ts
export const userRoleSchema = z.enum(["ADMIN", "MANAGER", "REGIONAL_MANAGER", "DEVELOPER"]);
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npx vitest run tests/users-validation.test.ts`
Expected: PASS.

- [ ] **Step 5: Widen `FinalizerRole`**

`validateFinalizable` takes `session.user.role`, so this union must cover every `Role` value or the call site stops compiling. In `src/lib/validation/finalize.ts`, replace:

```ts
export type FinalizerRole = "ADMIN" | "MANAGER" | "DEVELOPER";
```

with:

```ts
export type FinalizerRole = "ADMIN" | "MANAGER" | "REGIONAL_MANAGER" | "DEVELOPER";
```

No rule in `validateFinalizable` branches on `role` (it is `void role`-ed with a comment explaining that the region caps are hard limits for every role), so widening the union is the whole change: a regional manager finalizing a quote in their region meets exactly the same caps as its author would.

- [ ] **Step 6: Widen the two query-layer role unions**

In `src/lib/queries/users.ts`, replace both occurrences (one in `UserListItem`, one in `UserDetail`) of:

```ts
  role: "ADMIN" | "MANAGER" | "DEVELOPER";
```

with:

```ts
  role: "ADMIN" | "MANAGER" | "REGIONAL_MANAGER" | "DEVELOPER";
```

Run `grep -n 'role: "ADMIN"' src/lib/queries/users.ts` afterwards and confirm two hits, both widened.

- [ ] **Step 7: Add the option to the create form**

In `src/components/users/user-form.tsx`, replace:

```tsx
            <option value="MANAGER">Manager</option>
            <option value="ADMIN">Admin</option>
            <option value="DEVELOPER">Developer</option>
```

with:

```tsx
            <option value="MANAGER">Manager</option>
            <option value="REGIONAL_MANAGER">Regional manager</option>
            <option value="ADMIN">Admin</option>
            <option value="DEVELOPER">Developer</option>
```

- [ ] **Step 8: Add the option to the edit form and widen its prop type**

In `src/components/users/edit-user-form.tsx`, replace:

```ts
  role: "ADMIN" | "MANAGER" | "DEVELOPER";
```

with:

```ts
  role: "ADMIN" | "MANAGER" | "REGIONAL_MANAGER" | "DEVELOPER";
```

and replace:

```tsx
            <option value="MANAGER">Manager</option>
            <option value="ADMIN">Admin</option>
            <option value="DEVELOPER">Developer</option>
```

with:

```tsx
            <option value="MANAGER">Manager</option>
            <option value="REGIONAL_MANAGER">Regional manager</option>
            <option value="ADMIN">Admin</option>
            <option value="DEVELOPER">Developer</option>
```

- [ ] **Step 9: Teach the CLI script the role**

A regional manager without a region sees nothing (both filters fail closed), so the script must refuse to create one without a real region rather than warning and carrying on. In `scripts/create-user.ts`, replace:

```ts
  const [email, password, roleArg, regionCode = "AU"] = process.argv.slice(2);
  if (!email) {
    console.error("usage: tsx scripts/create-user.ts <email> [password] [ADMIN|MANAGER] [regionCode]");
    process.exit(1);
  }
```

with:

```ts
  const [email, password, roleArg, regionCode = "AU"] = process.argv.slice(2);
  if (!email) {
    console.error(
      "usage: tsx scripts/create-user.ts <email> [password] [ADMIN|MANAGER|REGIONAL_MANAGER] [regionCode]"
    );
    process.exit(1);
  }
```

and replace:

```ts
  // Strict role validation: an explicitly-provided value must be ADMIN or
  // MANAGER -- no silent fallback to ADMIN for a typo'd/invalid role. Only
  // an omitted arg defaults to ADMIN.
  let role: (typeof Role)[keyof typeof Role];
  if (roleArg === undefined) {
    role = Role.ADMIN;
  } else if (roleArg === "ADMIN" || roleArg === "MANAGER") {
    role = Role[roleArg];
  } else {
    console.error(`error: invalid role "${roleArg}", expected ADMIN or MANAGER`);
    process.exit(1);
  }

  const region = await db.region.findUnique({ where: { code: regionCode } });
  if (!region) console.warn(`warning: region ${regionCode} not found, user created without region`);
```

with:

```ts
  // Strict role validation: an explicitly-provided value must be one of the
  // three assignable here -- no silent fallback to ADMIN for a typo'd/invalid
  // role. Only an omitted arg defaults to ADMIN. DEVELOPER is deliberately
  // absent: it is the support-form recipient and is granted in the app, not
  // from a shell.
  let role: (typeof Role)[keyof typeof Role];
  if (roleArg === undefined) {
    role = Role.ADMIN;
  } else if (roleArg === "ADMIN" || roleArg === "MANAGER" || roleArg === "REGIONAL_MANAGER") {
    role = Role[roleArg];
  } else {
    console.error(
      `error: invalid role "${roleArg}", expected ADMIN, MANAGER or REGIONAL_MANAGER`
    );
    process.exit(1);
  }

  const region = await db.region.findUnique({ where: { code: regionCode } });
  if (!region) {
    // A REGIONAL_MANAGER with no region sees nothing at all: both
    // `companyWhereForUser` and `documentWhereForUser` fail closed on an
    // empty region id (src/lib/scope.ts), and `requireRegion` bounces them
    // to /no-region. Creating one that way produces an account that looks
    // fine in the users list and is useless on every screen, so refuse.
    if (role === Role.REGIONAL_MANAGER) {
      console.error(
        `error: region ${regionCode} not found — a REGIONAL_MANAGER must have a real region`
      );
      process.exit(1);
    }
    console.warn(`warning: region ${regionCode} not found, user created without region`);
  }
```

- [ ] **Step 10: Lint and test**

Run: `npx eslint && npx vitest run 2>&1 | tail -10`
Expected: no eslint output; suite green.

- [ ] **Step 11: Commit**

```bash
git add src/lib/validation/users.ts src/lib/validation/finalize.ts src/lib/queries/users.ts src/components/users/user-form.tsx src/components/users/edit-user-form.tsx scripts/create-user.ts tests/users-validation.test.ts
git commit -m "feat: make REGIONAL_MANAGER assignable from the user forms and CLI

Widens the zod enum, FinalizerRole and the two query-layer role unions, adds
the option to both user forms, and refuses to create one from the CLI without
a real region -- a region-less regional manager sees nothing.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011xz3fCTvKZWdeWNKoMNdLU"
```

---

## Task 5: Render the role legibly wherever it is shown

`REGIONAL_MANAGER` in a badge is shouting an enum value at a person. Four call sites print the raw string.

**Files:**
- Modify: `src/components/ui-kit/status-badge.tsx:21-29`
- Modify: `src/components/app-shell.tsx` (two badges)
- Modify: `src/app/(app)/settings/users/page.tsx` (row + card)
- Modify: `src/app/(app)/settings/users/[userId]/page.tsx` (header badge)

- [ ] **Step 1: Find every place a raw role string is rendered**

Run: `grep -rn "{user.role}\|{u.role}\|>{role}<" src/components src/app`
Expected: 5 hits — two in `app-shell.tsx`, two in `settings/users/page.tsx`, one in `settings/users/[userId]/page.tsx`. Every one of them becomes `roleLabel(...)` below; if the grep finds more, they get the same treatment.

- [ ] **Step 2: Add a tone for the new role**

In `src/components/ui-kit/status-badge.tsx`, replace:

```ts
  ADMIN: "brand",
  MANAGER: "brand-outline",
  // Same admin rights as ADMIN (see isAdminRole) but its own tone so a
  // glance at a badge still tells the two apart — the support form (Settings
  // → PathQuote Support) addresses its message to whoever holds this role.
  DEVELOPER: "violet",
```

with:

```ts
  ADMIN: "brand",
  MANAGER: "brand-outline",
  // A wider-scoped manager, not a lesser admin (see isRegionalManagerRole) —
  // so it reads as a manager variant rather than borrowing ADMIN's filled
  // brand pill, which is the badge a person scans for "can change the
  // catalogue".
  REGIONAL_MANAGER: "brand-outline",
  // Same admin rights as ADMIN (see isAdminRole) but its own tone so a
  // glance at a badge still tells the two apart — the support form (Settings
  // → PathQuote Support) addresses its message to whoever holds this role.
  DEVELOPER: "violet",
```

- [ ] **Step 3: Label the app-shell badges**

In `src/components/app-shell.tsx`, change the import line:

```ts
import { isAdminRole } from "@/lib/roles";
```

to:

```ts
import { isAdminRole, roleLabel } from "@/lib/roles";
```

and replace both badge bodies — the mobile one:

```tsx
              {user.role}
```

with:

```tsx
              {roleLabel(user.role)}
```

and the desktop one:

```tsx
            <StatusBadge tone={roleTone}>{user.role}</StatusBadge>
```

with:

```tsx
            <StatusBadge tone={roleTone}>{roleLabel(user.role)}</StatusBadge>
```

- [ ] **Step 4: Label the users list**

In `src/app/(app)/settings/users/page.tsx`, change:

```ts
import { isAdminRole } from "@/lib/roles";
```

to:

```ts
import { isAdminRole, roleLabel } from "@/lib/roles";
```

and replace **both** occurrences of:

```tsx
        <StatusBadge tone={STATUS_TONE[u.role]}>{u.role}</StatusBadge>
```

with:

```tsx
        <StatusBadge tone={STATUS_TONE[u.role]}>{roleLabel(u.role)}</StatusBadge>
```

(One is in `UserRow` inside a `RowCell`, one in `UserCard`; the surrounding indentation differs, so apply each in place rather than as a single global replace if the tool insists on unique matches.)

- [ ] **Step 5: Label the user detail header**

In `src/app/(app)/settings/users/[userId]/page.tsx`, change:

```ts
import { isAdminRole } from "@/lib/roles";
```

to:

```ts
import { isAdminRole, roleLabel } from "@/lib/roles";
```

and replace:

```tsx
        <StatusBadge tone={STATUS_TONE[user.role]}>{user.role}</StatusBadge>
```

with:

```tsx
        <StatusBadge tone={STATUS_TONE[user.role]}>{roleLabel(user.role)}</StatusBadge>
```

- [ ] **Step 6: Confirm no raw role string is left**

Run: `grep -rn "{user.role}\|{u.role}" src/components src/app`
Expected: no output.

- [ ] **Step 7: Lint and test**

Run: `npx eslint && npx vitest run 2>&1 | tail -10`
Expected: no eslint output; suite green.

- [ ] **Step 8: Commit**

```bash
git add src/components/ui-kit/status-badge.tsx src/components/app-shell.tsx "src/app/(app)/settings/users/page.tsx" "src/app/(app)/settings/users/[userId]/page.tsx"
git commit -m "feat: render role badges through roleLabel

REGIONAL_MANAGER in a badge is an enum value shouted at a person. One label
map in roles.ts, five call sites through it, and a manager-variant tone so the
filled brand pill stays the 'can change the catalogue' signal.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011xz3fCTvKZWdeWNKoMNdLU"
```

---

## Task 6: Carry the author into the /quotes list query

**Files:**
- Modify: `src/lib/queries/documents-list.ts`

- [ ] **Step 1: Add the field to `DocumentListItem`**

In `src/lib/queries/documents-list.ts`, replace:

```ts
  /** `Document.signingStatus` — feeds the list's signing badge (see
   * `signingStatusLabel`, src/lib/signing/state.ts) beside the existing
   * DRAFT/FINAL one. `NOT_SENT` is the common case and renders nothing. */
  signingStatus: SigningStatus;
};
```

with:

```ts
  /** `Document.signingStatus` — feeds the list's signing badge (see
   * `signingStatusLabel`, src/lib/signing/state.ts) beside the existing
   * DRAFT/FINAL one. `NOT_SENT` is the common case and renders nothing. */
  signingStatus: SigningStatus;
  /** Who wrote the quote — `User.name`, falling back to `User.email` when a
   * user has no name set (the same fallback the users list makes). Feeds the
   * list's `Salesperson` column, which is rendered for every role whose list
   * can hold more than one person's quotes (`canSeeSalesperson`,
   * src/lib/roles.ts) and omitted for a MANAGER.
   *
   * Always selected, never conditionally: the read is a join on an indexed FK
   * that is already loaded for the row, and making the SELECT depend on the
   * viewer's role would mean two shapes of `DocumentListItem` and a caller
   * that has to remember which one it got. The role decides what is
   * displayed, not what is fetched. */
  salespersonName: string;
};
```

- [ ] **Step 2: Select the author and map it**

In the same file, replace:

```ts
      signingStatus: true,
      company: { select: { name: true } },
    },
  });

  return documents.map((d) => ({
    id: d.id,
    status: d.status,
    number: d.number,
    companyName: d.company?.name ?? null,
    total: d.total.toString(),
    currency: d.currency,
    currencySymbol: d.currencySymbol,
    updatedAt: d.updatedAt,
    signingStatus: d.signingStatus,
  }));
```

with:

```ts
      signingStatus: true,
      company: { select: { name: true } },
      // `authorId` is a required column with an FK to User, so `author` is
      // never null -- unlike `company`, which is null until the builder's
      // client step. No `?.` needed below.
      author: { select: { name: true, email: true } },
    },
  });

  return documents.map((d) => ({
    id: d.id,
    status: d.status,
    number: d.number,
    companyName: d.company?.name ?? null,
    total: d.total.toString(),
    currency: d.currency,
    currencySymbol: d.currencySymbol,
    updatedAt: d.updatedAt,
    signingStatus: d.signingStatus,
    salespersonName: d.author.name ?? d.author.email,
  }));
```

- [ ] **Step 3: Update the function's doc comment**

Replace:

```ts
/**
 * Documents visible to `user` (all for ADMIN, own-only for MANAGER, via
 * `documentWhereForUser`), optionally narrowed by a case-insensitive search
 * on the client company's name, newest-edited first. A document with no
 * client yet (`companyId` is null pre-Task-D-finalize) never matches a
 * non-empty `q`.
 */
```

with:

```ts
/**
 * Documents visible to `user` — all for ADMIN, this region's for a
 * REGIONAL_MANAGER, own-only for MANAGER, all via `documentWhereForUser` —
 * optionally narrowed by a case-insensitive search on the client company's
 * name, newest-edited first. A document with no client yet (`companyId` is
 * null pre-Task-D-finalize) never matches a non-empty `q`.
 */
```

- [ ] **Step 4: Lint and test**

Run: `npx eslint src/lib/queries && npx vitest run 2>&1 | tail -10`
Expected: no eslint output; suite green. (`npx tsc --noEmit` still reports the stale-Prisma-client errors from Task 1 Step 8 until the client is regenerated.)

- [ ] **Step 5: Commit**

```bash
git add src/lib/queries/documents-list.ts
git commit -m "feat: return the quote author from the /quotes list query

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011xz3fCTvKZWdeWNKoMNdLU"
```

---

## Task 7: The Salesperson column on /quotes

Last column, after Updated and before the actions cell — and absent entirely for a MANAGER.

**Files:**
- Modify: `src/components/documents/quotes-list.tsx`
- Modify: `src/app/(app)/quotes/page.tsx`

- [ ] **Step 1: Add the field and the flag to `QuoteListRow` / `QuotesList`**

In `src/components/documents/quotes-list.tsx`, replace:

```ts
  updatedLabel: string;
  updatedAtMs: number;
  canDelete: boolean;
};

type SortKey = "number" | "type" | "company" | "total" | "status" | "updated";

export function QuotesList({
  rows,
  deleteAction,
}: {
  rows: QuoteListRow[];
  /** `deleteDocument`, handed down from the server page — a server action
   * passes through a client component as a reference, and it re-checks
   * every permission server-side regardless of which rows rendered a
   * button. */
  deleteAction: (documentId: string) => Promise<ActionResult>;
}) {
```

with:

```ts
  updatedLabel: string;
  updatedAtMs: number;
  canDelete: boolean;
  /** Who wrote the quote (see `DocumentListItem.salespersonName`). Present on
   * every row regardless of viewer — `showSalesperson` below decides whether
   * it is rendered, and a MANAGER's rows are all their own anyway. */
  salespersonLabel: string;
};

type SortKey = "number" | "type" | "company" | "total" | "status" | "updated" | "salesperson";

export function QuotesList({
  rows,
  deleteAction,
  showSalesperson,
}: {
  rows: QuoteListRow[];
  /** `deleteDocument`, handed down from the server page — a server action
   * passes through a client component as a reference, and it re-checks
   * every permission server-side regardless of which rows rendered a
   * button. */
  deleteAction: (documentId: string) => Promise<ActionResult>;
  /** Whether to render the trailing `Salesperson` column — `canSeeSalesperson`
   * (src/lib/roles.ts), resolved on the server page. False for a MANAGER,
   * whose list is their own quotes and for whom the column would be one name
   * repeated down the page.
   *
   * Also gates whether the name joins the search text, so a manager's search
   * matches only what is on their screen — the rule this component's own
   * header comment states about every other column. */
  showSalesperson: boolean;
}) {
```

- [ ] **Step 2: Add it to sorting and search**

In the same file, replace:

```ts
    sortValues: (row) => ({
      number: row.numberLabel,
      type: "Quote",
      company: row.companyLabel,
      total: row.totalValue,
      status: `${row.statusLabel} ${row.signingLabel ?? ""}`,
      updated: row.updatedAtMs,
    }),
    searchText: (row) =>
      [
        row.numberLabel,
        "Quote",
        row.companyLabel,
        row.totalLabel,
        row.statusLabel,
        row.signingLabel ?? "",
        row.updatedLabel,
      ].join(" "),
  });
```

with:

```ts
    sortValues: (row) => ({
      number: row.numberLabel,
      type: "Quote",
      company: row.companyLabel,
      total: row.totalValue,
      status: `${row.statusLabel} ${row.signingLabel ?? ""}`,
      updated: row.updatedAtMs,
      salesperson: row.salespersonLabel,
    }),
    searchText: (row) =>
      [
        row.numberLabel,
        "Quote",
        row.companyLabel,
        row.totalLabel,
        row.statusLabel,
        row.signingLabel ?? "",
        row.updatedLabel,
        showSalesperson ? row.salespersonLabel : "",
      ].join(" "),
  });
```

- [ ] **Step 3: Add the header cell and pass the flag down**

Replace:

```tsx
                  <SortableTh label="Updated" sortKey="updated" sort={sort} onSort={toggleSort} />
                  <th scope="col" className="px-4 py-3">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => (
                  <DocumentRow key={row.id} row={row} deleteAction={deleteAction} />
                ))}
              </tbody>
            </table>
          }
          cards={visible.map((row) => (
            <DocumentCard key={row.id} row={row} deleteAction={deleteAction} />
          ))}
```

with:

```tsx
                  <SortableTh label="Updated" sortKey="updated" sort={sort} onSort={toggleSort} />
                  {showSalesperson ? (
                    <SortableTh
                      label="Salesperson"
                      sortKey="salesperson"
                      sort={sort}
                      onSort={toggleSort}
                    />
                  ) : null}
                  <th scope="col" className="px-4 py-3">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => (
                  <DocumentRow
                    key={row.id}
                    row={row}
                    deleteAction={deleteAction}
                    showSalesperson={showSalesperson}
                  />
                ))}
              </tbody>
            </table>
          }
          cards={visible.map((row) => (
            <DocumentCard
              key={row.id}
              row={row}
              deleteAction={deleteAction}
              showSalesperson={showSalesperson}
            />
          ))}
```

- [ ] **Step 4: Render the cell in the table row**

Replace:

```tsx
function DocumentRow({
  row,
  deleteAction,
}: {
  row: QuoteListRow;
  deleteAction: (documentId: string) => Promise<ActionResult>;
}) {
  const href = `/quotes/${row.id}`;
```

with:

```tsx
function DocumentRow({
  row,
  deleteAction,
  showSalesperson,
}: {
  row: QuoteListRow;
  deleteAction: (documentId: string) => Promise<ActionResult>;
  showSalesperson: boolean;
}) {
  const href = `/quotes/${row.id}`;
```

and replace:

```tsx
      <RowCell href={href}>
        <span className="text-sm text-slate-500">{row.updatedLabel}</span>
      </RowCell>
      {/* Deliberately its own plain `<td>` (no `RowCell`/`Link`) — a delete
```

with:

```tsx
      <RowCell href={href}>
        <span className="text-sm text-slate-500">{row.updatedLabel}</span>
      </RowCell>
      {showSalesperson ? (
        <RowCell href={href}>
          <span className="text-sm text-slate-600">{row.salespersonLabel}</span>
        </RowCell>
      ) : null}
      {/* Deliberately its own plain `<td>` (no `RowCell`/`Link`) — a delete
```

- [ ] **Step 5: Render it on the mobile card**

Replace:

```tsx
function DocumentCard({
  row,
  deleteAction,
}: {
  row: QuoteListRow;
  deleteAction: (documentId: string) => Promise<ActionResult>;
}) {
```

with:

```tsx
function DocumentCard({
  row,
  deleteAction,
  showSalesperson,
}: {
  row: QuoteListRow;
  deleteAction: (documentId: string) => Promise<ActionResult>;
  showSalesperson: boolean;
}) {
```

and replace:

```tsx
            <p className="font-mono text-xs text-slate-500">
              {row.numberLabel} · {row.updatedLabel}
            </p>
```

with:

```tsx
            <p className="font-mono text-xs text-slate-500">
              {row.numberLabel} · {row.updatedLabel}
            </p>
            {/* On a card the author goes under the company rather than in its
                own column — same information, one line, no horizontal scroll. */}
            {showSalesperson ? (
              <p className="truncate text-xs text-slate-500">{row.salespersonLabel}</p>
            ) : null}
```

- [ ] **Step 6: Build the label and the flag on the server page**

In `src/app/(app)/quotes/page.tsx`, replace:

```ts
import { isAdminRole, isDeveloperRole } from "@/lib/roles";
```

with:

```ts
import { canSeeSalesperson, isAdminRole, isDeveloperRole } from "@/lib/roles";
```

then replace:

```ts
    updatedLabel: relativeDate(d.updatedAt),
    updatedAtMs: d.updatedAt.getTime(),
    canDelete: canDeleteFromList(d, session.user.role),
  }));
```

with:

```ts
    updatedLabel: relativeDate(d.updatedAt),
    updatedAtMs: d.updatedAt.getTime(),
    canDelete: canDeleteFromList(d, session.user.role),
    salespersonLabel: d.salespersonName,
  }));

  // Decided here, on the server, rather than inside the client component:
  // the role never reaches the browser this way, and the component stays a
  // renderer with no opinion about who is looking.
  const showSalesperson = canSeeSalesperson(session.user.role);
```

and replace:

```tsx
      <QuotesList rows={rows} deleteAction={deleteDocument} />
```

with:

```tsx
      <QuotesList rows={rows} deleteAction={deleteDocument} showSalesperson={showSalesperson} />
```

- [ ] **Step 7: Verify by hand in the browser**

Vadym runs the dev server (`npm run dev`) and checks `http://localhost:3100/quotes` as each role:

| Signed in as | Expected |
| --- | --- |
| MANAGER | own quotes only; **no** Salesperson column, and no `Salesperson` header on desktop or extra line on a card |
| REGIONAL_MANAGER (with a region) | every quote whose region is theirs, including their own; Salesperson column last, sortable, filled with names |
| ADMIN / DEVELOPER | every quote; Salesperson column last |
| REGIONAL_MANAGER with no region | redirected to `/no-region` by the `quotes/layout.tsx` guard |

Expected: all five rows behave as written. Search as the regional manager for a colleague's name and confirm the list narrows to that person's quotes.

- [ ] **Step 8: Lint and test**

Run: `npx eslint && npx vitest run 2>&1 | tail -10`
Expected: no eslint output; suite green.

- [ ] **Step 9: Commit**

```bash
git add src/components/documents/quotes-list.tsx "src/app/(app)/quotes/page.tsx"
git commit -m "feat: add a Salesperson column to /quotes for everyone but a manager

Last column on the table, an extra line on the card, sortable, and part of
the search text only when it is rendered -- so a manager's search still
matches exactly what is on their screen.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011xz3fCTvKZWdeWNKoMNdLU"
```

---

## Task 8: Tell a regional manager what they are looking at

Three pages describe the scope of the list below them with a two-way `isAdminRole` ternary. A regional manager currently reads "Quotes you've created" above a list of the whole region's quotes.

**Files:**
- Modify: `src/app/(app)/quotes/page.tsx`
- Modify: `src/app/(app)/clients/page.tsx`
- Modify: `src/app/(app)/page.tsx`

- [ ] **Step 1: Add the shared helper**

Append to `src/lib/roles.ts`:

```ts
/**
 * The one-line description a list page puts under its title, chosen by what
 * the viewer's list actually contains. Three pages (/quotes, /clients, the
 * dashboard) asked this question with their own `isAdminRole` ternary, which
 * told a regional manager they were looking at their own rows while showing
 * them the region's.
 *
 * Takes the three sentences rather than owning them: the wording is the
 * page's business ("Every quote across the business." vs "Every company
 * across the business."), the choice is this file's.
 */
export function scopeDescription(
  role: string | null | undefined,
  copy: { everything: string; region: string; own: string }
): string {
  if (isAdminRole(role)) return copy.everything;
  if (isRegionalManagerRole(role)) return copy.region;
  return copy.own;
}
```

- [ ] **Step 2: Extend the roles test**

Append to `tests/roles.test.ts`:

```ts
describe("scopeDescription", () => {
  const copy = { everything: "all", region: "region", own: "mine" };

  it("gives an admin and a developer the everything line", () => {
    expect(scopeDescription("ADMIN", copy)).toBe("all");
    expect(scopeDescription("DEVELOPER", copy)).toBe("all");
  });

  it("gives a regional manager the region line", () => {
    expect(scopeDescription("REGIONAL_MANAGER", copy)).toBe("region");
  });

  // Same fail-narrow default as the scoping functions: an unrecognised role
  // is described as seeing only its own rows, which is what it will see.
  it("gives a manager, an unknown role and no role the own line", () => {
    expect(scopeDescription("MANAGER", copy)).toBe("mine");
    expect(scopeDescription("SUPERADMIN", copy)).toBe("mine");
    expect(scopeDescription(null, copy)).toBe("mine");
  });
});
```

and add `scopeDescription` to that file's import list from `../src/lib/roles`.

- [ ] **Step 3: Run the test**

Run: `npx vitest run tests/roles.test.ts`
Expected: PASS.

- [ ] **Step 4: Use it on /quotes**

In `src/app/(app)/quotes/page.tsx`, replace the import:

```ts
import { canSeeSalesperson, isAdminRole, isDeveloperRole } from "@/lib/roles";
```

with:

```ts
import { canSeeSalesperson, isAdminRole, isDeveloperRole, scopeDescription } from "@/lib/roles";
```

and replace:

```tsx
        description={
          isAdminRole(session.user.role) ? "Every quote across the business." : "Quotes you've created."
        }
```

with:

```tsx
        description={scopeDescription(session.user.role, {
          everything: "Every quote across the business.",
          region: "Every quote in your region.",
          own: "Quotes you've created.",
        })}
```

`isAdminRole` stays imported — `canDeleteFromList` at the bottom of the file still uses it.

- [ ] **Step 5: Use it on /clients**

In `src/app/(app)/clients/page.tsx`, replace:

```ts
import { isAdminRole } from "@/lib/roles";
```

with:

```ts
import { scopeDescription } from "@/lib/roles";
```

and replace:

```tsx
        description={
          isAdminRole(session.user.role)
            ? "Every company across the business."
            : "Companies you've added."
        }
```

with:

```tsx
        description={scopeDescription(session.user.role, {
          everything: "Every company across the business.",
          region: "Every company your region's managers look after.",
          own: "Companies you've added.",
        })}
```

- [ ] **Step 6: Use it on the dashboard**

In `src/app/(app)/page.tsx`, replace:

```ts
import { isAdminRole } from "@/lib/roles";
```

with:

```ts
import { scopeDescription } from "@/lib/roles";
```

and replace:

```tsx
        description={
          isAdminRole(session.user.role)
            ? "An overview of every quote across the business."
            : "An overview of your quotes and clients."
        }
```

with:

```tsx
        description={scopeDescription(session.user.role, {
          everything: "An overview of every quote across the business.",
          region: "An overview of your region's quotes and clients.",
          own: "An overview of your quotes and clients.",
        })}
```

- [ ] **Step 7: Confirm no unused import is left behind**

Run: `npx eslint "src/app/(app)/page.tsx" "src/app/(app)/clients/page.tsx" "src/app/(app)/quotes/page.tsx"`
Expected: no output. An `'isAdminRole' is defined but never used` here means a file still imports it without a remaining use — remove that import.

- [ ] **Step 8: Test and commit**

Run: `npx vitest run 2>&1 | tail -10`
Expected: suite green.

```bash
git add src/lib/roles.ts tests/roles.test.ts "src/app/(app)/quotes/page.tsx" "src/app/(app)/clients/page.tsx" "src/app/(app)/page.tsx"
git commit -m "feat: describe a regional manager's list scope correctly

Three pages had their own two-way isAdminRole ternary and told a regional
manager they were looking at their own rows. One helper, three call sites.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011xz3fCTvKZWdeWNKoMNdLU"
```

---

## Task 9: The Owner column on /clients

A regional manager's client list is now several managers' clients merged into one alphabetical list with nothing to say whose is whose — the same defect the Salesperson column fixes on /quotes. Same rule, same shape: last column, gated on `canSeeSalesperson`.

**This task goes beyond the literal request (Vadym asked for the column on /quotes only). It is here because the merged list is hard to use without it. Drop the task if he would rather ship without it — nothing later depends on it.**

**Files:**
- Modify: `src/lib/queries/clients.ts` (`CompanyListItem` + `listCompanies`)
- Modify: `src/components/clients/clients-list.tsx`
- Modify: `src/app/(app)/clients/page.tsx`

- [ ] **Step 1: Return the owner from the list query**

In `src/lib/queries/clients.ts`, replace:

```ts
  website: string | null;
  contactCount: number;
};

/**
 * Companies visible to `user` (all for ADMIN, own-only for MANAGER),
 * optionally filtered by a case-insensitive name search, ordered by name.
 * Each row carries its contact count for the list cards.
 */
```

with:

```ts
  website: string | null;
  contactCount: number;
  /** Which manager looks after this client — `User.name`, falling back to
   * `User.email`, and `null` for a company with no owner at all (possible:
   * `Company.ownerId` is nullable). Feeds the list's `Owner` column, shown to
   * the roles whose list can hold more than one manager's clients
   * (`canSeeSalesperson`, src/lib/roles.ts) — a regional manager's list is
   * several managers' clients merged, and unlabelled it is unusable.
   *
   * Always selected, never conditionally, for the reason
   * `DocumentListItem.salespersonName` gives: the role decides what is
   * displayed, not what is fetched. */
  ownerName: string | null;
};

/**
 * Companies visible to `user` — all for ADMIN, this region's managers' for a
 * REGIONAL_MANAGER, own-only for MANAGER — optionally filtered by a
 * case-insensitive name search, ordered by name. Each row carries its contact
 * count for the list cards and its owner's name for the `Owner` column.
 */
```

then replace:

```ts
  const companies = await db.company.findMany({
    where,
    orderBy: { name: "asc" },
    include: {
      _count: { select: { contacts: true } },
    },
  });

  return companies.map((c) => ({
    id: c.id,
    name: c.name,
    city: c.city,
    country: c.country,
    website: c.website,
    contactCount: c._count.contacts,
  }));
```

with:

```ts
  const companies = await db.company.findMany({
    where,
    orderBy: { name: "asc" },
    include: {
      _count: { select: { contacts: true } },
      // Nullable relation: `Company.ownerId` is optional (see the schema), so
      // a company imported or created without a resolvable owner has none.
      owner: { select: { name: true, email: true } },
    },
  });

  return companies.map((c) => ({
    id: c.id,
    name: c.name,
    city: c.city,
    country: c.country,
    website: c.website,
    contactCount: c._count.contacts,
    ownerName: c.owner ? (c.owner.name ?? c.owner.email) : null,
  }));
```

- [ ] **Step 2: Add the column to the list component**

In `src/components/clients/clients-list.tsx`, replace:

```ts
export type ClientListRow = {
  id: string;
  name: string;
  location: string;
  contactCount: number;
  contactsLabel: string;
  website: string | null;
};

type SortKey = "name" | "location" | "contacts";

export function ClientsList({ rows }: { rows: ClientListRow[] }) {
```

with:

```ts
export type ClientListRow = {
  id: string;
  name: string;
  location: string;
  contactCount: number;
  contactsLabel: string;
  website: string | null;
  /** Which manager looks after this client, already rendered by the server
   * page — "Unassigned" for a company with no owner, so the column never has
   * a blank cell to explain. */
  ownerLabel: string;
};

type SortKey = "name" | "location" | "contacts" | "owner";

export function ClientsList({
  rows,
  showOwner,
}: {
  rows: ClientListRow[];
  /** Whether to render the trailing `Owner` column — `canSeeSalesperson`
   * (src/lib/roles.ts), resolved on the server page. False for a MANAGER,
   * every one of whose clients is their own. Also gates whether the name
   * joins the search text, so a search matches only what is on screen. */
  showOwner: boolean;
}) {
```

then replace:

```ts
    sortValues: (row) => ({
      name: row.name,
      location: row.location,
      contacts: row.contactCount,
    }),
    searchText: (row) =>
      [row.name, row.location, row.contactsLabel, row.website ?? ""].join(" "),
  });
```

with:

```ts
    sortValues: (row) => ({
      name: row.name,
      location: row.location,
      contacts: row.contactCount,
      owner: row.ownerLabel,
    }),
    searchText: (row) =>
      [
        row.name,
        row.location,
        row.contactsLabel,
        row.website ?? "",
        showOwner ? row.ownerLabel : "",
      ].join(" "),
  });
```

- [ ] **Step 3: Render the header, the cell and the card line**

Replace:

```tsx
                  <SortableTh label="Contacts" sortKey="contacts" sort={sort} onSort={toggleSort} />
                  <th scope="col" className="px-4 py-3">
                    <span className="sr-only">Website</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => (
                  <CompanyRow key={row.id} row={row} />
                ))}
              </tbody>
            </table>
          }
          cards={visible.map((row) => (
            <CompanyCard key={row.id} row={row} />
          ))}
```

with:

```tsx
                  <SortableTh label="Contacts" sortKey="contacts" sort={sort} onSort={toggleSort} />
                  {showOwner ? (
                    <SortableTh label="Owner" sortKey="owner" sort={sort} onSort={toggleSort} />
                  ) : null}
                  <th scope="col" className="px-4 py-3">
                    <span className="sr-only">Website</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {visible.map((row) => (
                  <CompanyRow key={row.id} row={row} showOwner={showOwner} />
                ))}
              </tbody>
            </table>
          }
          cards={visible.map((row) => (
            <CompanyCard key={row.id} row={row} showOwner={showOwner} />
          ))}
```

then replace:

```tsx
function CompanyRow({ row }: { row: ClientListRow }) {
  const href = `/clients/${row.id}`;
```

with:

```tsx
function CompanyRow({ row, showOwner }: { row: ClientListRow; showOwner: boolean }) {
  const href = `/clients/${row.id}`;
```

then replace:

```tsx
      <RowCell href={href}>
        <span className="text-sm text-slate-500">{row.contactsLabel}</span>
      </RowCell>
      {/* Deliberately its own plain `<td>` (no `RowCell`/row link) — the
```

with:

```tsx
      <RowCell href={href}>
        <span className="text-sm text-slate-500">{row.contactsLabel}</span>
      </RowCell>
      {showOwner ? (
        <RowCell href={href}>
          <span className="text-sm text-slate-600">{row.ownerLabel}</span>
        </RowCell>
      ) : null}
      {/* Deliberately its own plain `<td>` (no `RowCell`/row link) — the
```

then replace:

```tsx
function CompanyCard({ row }: { row: ClientListRow }) {
```

with:

```tsx
function CompanyCard({ row, showOwner }: { row: ClientListRow; showOwner: boolean }) {
```

and replace:

```tsx
      <div className="relative flex items-center justify-between gap-3 text-sm text-slate-500">
        <span className="truncate">{row.location}</span>
        <span className="shrink-0">{row.contactsLabel}</span>
      </div>
```

with:

```tsx
      <div className="relative flex items-center justify-between gap-3 text-sm text-slate-500">
        <span className="truncate">{row.location}</span>
        <span className="shrink-0">{row.contactsLabel}</span>
      </div>
      {showOwner ? (
        <p className="relative truncate text-xs text-slate-500">{row.ownerLabel}</p>
      ) : null}
```

- [ ] **Step 4: Wire the page**

In `src/app/(app)/clients/page.tsx`, replace:

```ts
import { scopeDescription } from "@/lib/roles";
```

with:

```ts
import { canSeeSalesperson, scopeDescription } from "@/lib/roles";
```

then replace:

```ts
    contactsLabel: `${c.contactCount} ${c.contactCount === 1 ? "contact" : "contacts"}`,
    website: c.website,
  }));
```

with:

```ts
    contactsLabel: `${c.contactCount} ${c.contactCount === 1 ? "contact" : "contacts"}`,
    website: c.website,
    // "Unassigned" rather than an empty cell: a company with no owner is a
    // real state (`Company.ownerId` is nullable, and an ACT import that
    // cannot resolve an owner leaves it null), and a blank cell reads as a
    // rendering bug.
    ownerLabel: c.ownerName ?? "Unassigned",
  }));

  // Same predicate the /quotes Salesperson column uses, for the same reason:
  // a MANAGER's list is one person's rows, so the column would be one name
  // repeated down the page.
  const showOwner = canSeeSalesperson(session.user.role);
```

and replace:

```tsx
      <ClientsList rows={rows} />
```

with:

```tsx
      <ClientsList rows={rows} showOwner={showOwner} />
```

- [ ] **Step 5: Verify by hand**

Vadym checks `http://localhost:3100/clients`:

| Signed in as | Expected |
| --- | --- |
| MANAGER | own clients; no `Owner` column, no extra card line |
| REGIONAL_MANAGER | every client owned by a manager of their region, `Owner` column last and sortable; a client owned by nobody does **not** appear |
| ADMIN | every client, including `Unassigned` ones |

- [ ] **Step 6: Lint, test, commit**

Run: `npx eslint && npx vitest run 2>&1 | tail -10`
Expected: no eslint output; suite green.

```bash
git add src/lib/queries/clients.ts src/components/clients/clients-list.tsx "src/app/(app)/clients/page.tsx"
git commit -m "feat: add an Owner column to /clients for everyone but a manager

A regional manager's list is several managers' clients merged alphabetically;
unlabelled it is unusable. Same rule and shape as the Salesperson column.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011xz3fCTvKZWdeWNKoMNdLU"
```

---

## Task 10: Write down the ownership rules the new scope depends on

Two operational rules now have teeth and live nowhere a person would look: a leaver must keep their region, and an ACT import must set a real owner or none. Both follow from client scope being derived from the owner rather than stored on `Company`, and both are silent failures if broken.

**Files:**
- Create: `docs/reference/client-ownership-and-regional-scope.md`
- Modify: `src/lib/actions/users.ts` (the `reassignUserCompanies` doc comment)
- Test: `tests/scope.test.ts`

- [ ] **Step 1: Write the note**

Create `docs/reference/client-ownership-and-regional-scope.md`:

```markdown
# Client ownership and regional scope

`REGIONAL_MANAGER` (added 2026-09-22) sees its region's rows. The two filters
live in `src/lib/scope.ts` and answer "which region" differently, on purpose:

| Model | Filter | Why |
| --- | --- | --- |
| `Document` | `{ regionId }` | The column is frozen at creation from the author's own region (`createDraft`). A quote stays with the region whose currency, tax and discount caps priced it, even after its author moves. It is also the indexed column. |
| `Company` | `{ owner: { regionId } }` | `Company` has no region and must not get one (see the comment on `model Company`). A client belongs to the manager who looks after them — an Australian manager sells into Europe and that buyer is still their client, quoted out of Australia. |

## Rule 1 — a departing manager keeps their region

When someone leaves, deactivate the account (`setUserActive`) and, if their
clients should change hands, reassign them (`reassignUserCompanies`). **Do not
blank their `regionId`.** Their clients' visibility to their own regional
manager is computed through that column: clear it and every client still owned
by the leaver disappears from the regional manager's list while looking
perfectly correct to an admin. Their quotes are unaffected — `Document.regionId`
is the quote's own column — which makes the failure partial and therefore harder
to spot.

Reassignment within a region changes nothing anyone sees. Reassignment across
regions moves the clients to the other region's view, immediately and with no
second column to keep in step. That is the payoff for deriving the region
instead of copying it.

## Rule 2 — an ACT import sets a real owner, or none

Clients imported from ACT! are per-manager there and stay per-manager here.
The importer's only job for scope is to map each ACT owner to a PathQuote
`User` and set `Company.ownerId` to it; region visibility then follows with no
extra field.

When an owner cannot be resolved, leave `ownerId` null. Such a company is
visible to admins only (`{ owner: { regionId } }` matches no row whose owner is
null) — which is the correct, visible, fixable state. Never:

- guess an owner (it silently files a client into the wrong region's view);
- fall back to the importing admin (same, plus it looks deliberate);
- add a `regionId` column to `Company` to avoid needing an owner (two sources
  of truth that drift, and the schema comment explains why the column was
  refused in the first place).

## Rule 3 — a regional manager needs a region

Both filters fail closed on a missing region (`{ regionId: "" }` /
`{ owner: { regionId: "" } }`), and `requireRegion` sends the user to
`/no-region`. So a regional manager without a region is not dangerous, just
useless. `scripts/create-user.ts` refuses to create one; the admin user form
does not, because an admin can see and fix the region on the same screen.
```

- [ ] **Step 2: Point the reassignment action at the note**

In `src/lib/actions/users.ts`, replace:

```ts
 * Idempotent and safe to run on a user with no companies: it moves whatever is
 * there and reports how many.
 */
```

with:

```ts
 * Idempotent and safe to run on a user with no companies: it moves whatever is
 * there and reports how many.
 *
 * Since REGIONAL_MANAGER arrived (2026-09-22) this also decides which regional
 * manager sees the clients: their scope is `{ owner: { regionId } }`
 * (`companyWhereForUser`, src/lib/scope.ts), so moving a company between owners
 * moves it between regional views. Two consequences, both written up in
 * docs/reference/client-ownership-and-regional-scope.md: handing clients to a
 * manager in another region transfers them out of this region's list, and a
 * leaver whose `regionId` is blanked takes every client still owned by them out
 * of their own region's list. Deactivate the account; leave its region alone.
 */
```

- [ ] **Step 3: Pin rule 1 with a test**

Append to `tests/scope.test.ts`:

```ts
// The rules in docs/reference/client-ownership-and-regional-scope.md, stated
// as assertions so a future edit to `companyWhereForUser` cannot quietly
// break them. These are about the SHAPE of the filter, which is what makes
// each rule true — no database needed.
describe("what a regional manager's client filter implies", () => {
  const rm = { id: "rm", role: "REGIONAL_MANAGER", regionId: "r-au" };

  // Rule 1: visibility is computed from the owner's CURRENT region, so a
  // deactivated leaver's clients stay visible as long as that column does.
  // Nothing in the filter references `active`.
  it("does not filter on whether the owner can still sign in", () => {
    expect(companyWhereForUser(rm).owner).toEqual({ regionId: "r-au" });
    expect(JSON.stringify(companyWhereForUser(rm))).not.toContain("active");
  });

  // Rule 2: an owner-less company matches no regional manager. A relation
  // filter on `owner` cannot match a null relation, so this holds by
  // construction — the assertion is that the filter keeps going through the
  // relation rather than being flattened to an `ownerId in (...)` list, which
  // is where a "helpful" optimisation would start matching nulls.
  it("filters through the owner relation, so an owner-less company never matches", () => {
    const where = companyWhereForUser(rm);
    expect(where).toHaveProperty("owner");
    expect(where).not.toHaveProperty("ownerId");
  });
});
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run tests/scope.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add docs/reference/client-ownership-and-regional-scope.md src/lib/actions/users.ts tests/scope.test.ts
git commit -m "docs: write down the ownership rules regional scope depends on

A leaver must keep their regionId and an ACT import must set a real owner or
none -- both silent failures, both consequences of deriving a client's region
from its owner instead of storing it.

Co-Authored-By: Claude Opus 5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_011xz3fCTvKZWdeWNKoMNdLU"
```

---

## Task 11: Full verification

REQUIRED SUB-SKILL: `superpowers:verification-before-completion`. Nothing below is a claim until its command has been run and its output read.

- [ ] **Step 1: Confirm the Prisma client is current**

Run: `node -e "const {Role}=require('@prisma/client');console.log(Object.keys(Role))"`
Expected: `[ 'ADMIN', 'MANAGER', 'DEVELOPER', 'REGIONAL_MANAGER' ]`. If `REGIONAL_MANAGER` is missing, Task 1 Step 8 has not been done and the typecheck below is meaningless — stop and do it.

- [ ] **Step 2: Typecheck**

Run: `npx tsc --noEmit 2>&1 | tee /tmp/tsc-regional-manager.txt | tail -30`
Expected: no output from `tsc` (it takes 90-150s). Any error mentioning `REGIONAL_MANAGER` or `Role` means the generated client is stale — recheck Step 1. Any other error is a real defect in this work.

- [ ] **Step 3: Lint and test**

Run: `npx eslint && npx vitest run 2>&1 | tail -20`
Expected: no eslint output; the Preflight baseline pass count plus the new cases; zero failures.

- [ ] **Step 4: Confirm no admin right leaked**

Run: `grep -rn "isAdminRole" src/lib/roles.ts`
Expected: `ADMIN_ROLES` still contains exactly `"ADMIN"` and `"DEVELOPER"`. If `REGIONAL_MANAGER` appears in that set, the role has silently acquired the catalogue editor, region settings, user administration, import/export, uploads and signed-quote deletion — revert it.

- [ ] **Step 5: Confirm the scope-coverage guard still holds**

Run: `npx vitest run tests/scope-coverage.test.ts`
Expected: PASS with no new allowlist entry. Every module this plan touched that queries `db.company` or `db.document` already imports from `@/lib/scope`; if this fails, a new query was added without a scope import.

- [ ] **Step 6: Walk the role matrix in the browser**

Vadym, with `npm run dev` running, signed in as a `REGIONAL_MANAGER` who has a region:

| Check | Expected |
| --- | --- |
| `/quotes` | every quote in the region, Salesperson column last |
| open a colleague's quote | builder opens (not 404), fields editable |
| edit, then finalize a colleague's draft | both succeed |
| unfinalize a colleague's unsigned FINAL quote | succeeds |
| delete a colleague's draft | button present, delete succeeds |
| delete a colleague's **signed** quote | no delete button, and the action refuses if forced — `canDeleteDocument` is DEVELOPER-only |
| `/clients` | every client of the region's managers; opening and saving one succeeds |
| `/catalog` | read-only — no add/edit/price controls |
| `/settings/users` | 404 |
| `/settings/regions`, `/settings/industries`, `/settings/import-export` | 404 |
| `/documents` (Terms etc.) | readable, no editor, no Save |
| a quote in **another** region, by URL | 404 |
| a client of **another** region's manager, by URL | 404 |

Expected: every row as written. The last two are the ones worth doing twice — they are the actual security boundary.

- [ ] **Step 7: Commit anything the verification changed**

If steps 2-6 produced fixes, commit them with a message naming what the verification caught. If nothing changed, skip.

---

## Self-Review

Run against the request before handing over.

**Spec coverage**

| Requirement | Task |
| --- | --- |
| New role between Admin and Manager | 1 (enum, migration, predicate), 4 (assignable), 5 (rendered) |
| Everything a Manager can do | 1 — `REGIONAL_MANAGER` is absent from `isAdminRole`, so every manager-level path is unchanged; `requireRegion`, `priceWhereForUser`, `assertRegionWritable` and catalogue visibility all treat it as a non-admin already |
| See all managers' quotes in the region | 2 (`documentWhereForUser` → `{ regionId }`) |
| Full editing of those quotes (Vadym, 2026-09-22) | 2 — the filter is shared by reads and writes; Task 11 Step 6 walks the edit/finalize/unfinalize/delete matrix |
| See the quote author, including on own quotes | 6 (query), 7 (column, every row including the viewer's own) |
| `Salesperson` as the **last** column | 7 — after Updated, before the actions cell, which carries no header |
| Everyone except Manager sees it | 1 (`canSeeSalesperson` allow-set), 7 (gate) |
| See and edit all clients of the region | 2 (`companyWhereForUser` → `{ owner: { regionId } }`); editing follows since `updateCompany`, contacts and `deleteCompany` all load through it |
| Bind clients by manager, not by region (Vadym) | 2 — the filter goes through `owner`, and `Company` gets no region column |
| What happens when a manager leaves | 10, Rule 1 + the `reassignUserCompanies` comment + two tests |
| ACT import must fit | 10, Rule 2 — importer sets `ownerId`, nothing else |
| No creating on others' behalf, no Users access | not implemented, by decision — `createCompany`/`createDraft` still stamp the session user, and `/settings/users` stays `isAdminRole` |

**Placeholders:** none. Every code step carries the code, every command carries its expected output, and the two steps that cannot run in the sandbox (`prisma generate`, the browser walk) say so and say who runs them.

**Type consistency:** `salespersonName` (query) → `salespersonLabel` (row view model) and `ownerName` → `ownerLabel` are deliberate renames at the server/client boundary, matching the existing `companyName`/`companyLabel` pair. `showSalesperson` and `showOwner` are the prop names throughout their own components. `regionalScopeId`, `CompanyScopeWhere`, `DocumentScopeWhere`, `isRegionalManagerRole`, `canSeeSalesperson`, `roleLabel` and `scopeDescription` are each defined once and referenced under exactly those names. The `cache()` memos take `(userId, role, regionId, id)` in that order in all three signatures.
