# Manager Permissions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Restrict `MANAGER` to their own clients and quotes, and to their own region's prices and catalogue, with no path — UI, direct URL, or foreign id passed to a server action — to anyone else's data.

**Architecture:** Extend the existing call-site scoping pattern in `src/lib/scope.ts` with a second axis (region) alongside the existing ownership axis, then back it with two safety nets: `requireAdmin()` in a `layout.tsx` per admin-only Settings segment, and a structural test that fails when a query module touches a scoped model without importing `@/lib/scope`.

**Tech Stack:** Next.js (App Router, server components + server actions), Prisma, NextAuth v5, Zod, Vitest, Tailwind.

**Spec:** `docs/superpowers/specs/2026-09-06-manager-permissions-design.md`

**Deliberately not in this plan**, because the spec settled them and a reader will otherwise look for the task:

- The main navigation is unchanged. Both roles keep the same four entries — Documents, Clients, Catalog, Settings. A manager's restriction is what the Catalog entry leads to, not a shorter menu.
- `CatalogVisibility` stays per user. Nothing is migrated to region, and no tooling is added to copy or seed it for a new manager.
- No owner or author column is removed from any list, because neither `listCompanies` nor `listDocuments` selects one.

---

## Background an engineer new to this codebase needs

**Roles.** Three exist: `ADMIN`, `MANAGER`, `DEVELOPER`. `DEVELOPER` has identical rights to `ADMIN`; the only difference is that the support form addresses its message to whoever holds it. Never compare a role to the string `"ADMIN"` — always call `isAdminRole(role)` from `src/lib/roles.ts`.

**Scoping convention.** `src/lib/scope.ts` exports pure functions returning a Prisma `where` fragment, spread into a query:

```ts
const company = await db.company.findFirst({
  where: { id: companyId, ...companyWhereForUser(session.user) },
});
```

That file must stay dependency-free — no `@/lib/db`, no `@prisma/client` — so it unit-tests without a database. Do not add imports to it beyond `./roles`.

**Not-found over forbidden.** A row outside the caller's scope must be indistinguishable from a row that does not exist: `notFound()` in a page, `{ error: NOT_FOUND_ERROR }` from an action. A 403 confirms the row exists and turns id enumeration into an oracle. `NOT_FOUND_ERROR` lives in `src/lib/actions/_shared.ts`.

**Action result shape.** Every server action returns `ActionResult` = `{ error?: string }`. `{}` means success.

**Test suite.** Vitest, `tests/**/*.test.ts`, `environment: 'node'`. The suite runs with `isolate: false` and uses **no** `vi.mock`, no `vi.fn`, no fake timers, no network and no database — every test imports pure functions and asserts on return values. Honour that: the tests in this plan are all pure, plus one that reads files off disk with `node:fs`, which is safe (no module state).

**Commands.**

```bash
npm test                 # full vitest run
npx vitest run tests/scope.test.ts    # one file
npm run typecheck        # next typegen && tsc --noEmit
npm run lint             # eslint
```

---

## File structure

**Created:**

| File | Responsibility |
|---|---|
| `tests/region-scope.test.ts` | Unit tests for the three new region helpers |
| `tests/scope-coverage.test.ts` | Structural test: scoped models require a `@/lib/scope` import |
| `src/app/(app)/no-region/page.tsx` | The "region not assigned" dead-end screen |
| `src/app/(app)/documents/layout.tsx` | `requireRegion()` guard for the Documents area |
| `src/app/(app)/clients/layout.tsx` | `requireRegion()` guard for the Clients area |
| `src/app/(app)/catalog/layout.tsx` | `requireRegion()` guard for the Catalog area |
| `src/app/(app)/settings/users/layout.tsx` | `requireAdmin()` segment guard |
| `src/app/(app)/settings/regions/layout.tsx` | `requireAdmin()` segment guard |
| `src/app/(app)/settings/preferences/layout.tsx` | `requireAdmin()` segment guard |
| `src/app/(app)/settings/content/layout.tsx` | `requireAdmin()` segment guard |
| `src/app/(app)/settings/option-conflict-groups/layout.tsx` | `requireAdmin()` segment guard |
| `src/app/(app)/settings/spec-images/layout.tsx` | `requireAdmin()` segment guard |
| `src/app/(app)/settings/import-export/layout.tsx` | `requireAdmin()` segment guard |
| `src/components/users/change-own-password-form.tsx` | Self-service password form for Account |

**Modified:**

| File | Change |
|---|---|
| `src/lib/scope.ts` | Add `RegionScopeUser`, `regionIdForUser`, `priceWhereForUser`, `assertRegionWritable` |
| `src/lib/authz.ts` | Add `requireRegion()` |
| `src/lib/settings-nav.ts` | `Preferences` becomes `adminOnly: true` |
| `src/lib/queries/catalog.ts` | `getProductDetailById` / `getOptionDetailById` take a region filter |
| `src/lib/queries/industries.ts` | `countCompaniesUsingIndustry` gains an admin-only contract |
| `src/lib/actions/clients.ts` | `assertRegionWritable` in `createCompany` / `updateCompany` |
| `src/lib/actions/documents/lifecycle.ts` | `createDraft` throws instead of falling back to `AU` |
| `src/lib/actions/users.ts` | Add `changeOwnPassword` |
| `src/app/(app)/settings/page.tsx` | Account gains avatar + password controls |
| `src/app/(app)/page.tsx` | Dashboard greeting loses the avatar editor |
| `src/app/(app)/clients/new/page.tsx` | Region derived from session for a manager |
| `src/app/(app)/clients/[companyId]/page.tsx` | Same, plus the industry-count change |
| `src/app/(app)/documents/[documentId]/page.tsx` | Region list narrowed for a manager |
| `src/components/builder/client-section.tsx` | Region field hidden when only one region is offered |
| `src/components/clients/company-form.tsx` | Region field hidden when only one region is offered |
| `src/app/(app)/catalog/[seriesId]/[productId]/page.tsx` | Pass the viewer's region to the query |
| `src/app/(app)/catalog/options/[optionId]/page.tsx` | Pass the viewer's region to the query |
| `docs/runbook.md` | Note the new "region required" operational rule |

---

## Task 1: Region scoping helpers

The pure core everything else builds on. Ownership scoping already exists and is untouched; this adds the region axis beside it.

**Files:**
- Modify: `src/lib/scope.ts`
- Test: `tests/region-scope.test.ts` (create)

- [ ] **Step 1: Write the failing test**

Create `tests/region-scope.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  regionIdForUser,
  priceWhereForUser,
  assertRegionWritable,
  REGION_REQUIRED_ERROR,
  FOREIGN_REGION_ERROR,
} from "../src/lib/scope";

const admin = { id: "u1", role: "ADMIN", regionId: "r-au" };
const developer = { id: "u2", role: "DEVELOPER", regionId: null };
const manager = { id: "u3", role: "MANAGER", regionId: "r-au" };
const managerNoRegion = { id: "u4", role: "MANAGER", regionId: null };

describe("regionIdForUser", () => {
  it("returns null for an ADMIN, meaning every region", () => {
    expect(regionIdForUser(admin)).toBeNull();
  });

  it("returns null for a DEVELOPER, same as an ADMIN", () => {
    expect(regionIdForUser(developer)).toBeNull();
  });

  it("returns the manager's own region", () => {
    expect(regionIdForUser(manager)).toBe("r-au");
  });

  it("returns null for a manager with no region, which callers must treat as blocked", () => {
    expect(regionIdForUser(managerNoRegion)).toBeNull();
  });
});

describe("priceWhereForUser", () => {
  it("returns no restriction for an ADMIN", () => {
    expect(priceWhereForUser(admin)).toEqual({});
  });

  it("returns no restriction for a DEVELOPER", () => {
    expect(priceWhereForUser(developer)).toEqual({});
  });

  it("restricts to the manager's region", () => {
    expect(priceWhereForUser(manager)).toEqual({ regionId: "r-au" });
  });

  it("restricts a region-less manager to a region id that matches nothing", () => {
    expect(priceWhereForUser(managerNoRegion)).toEqual({ regionId: "" });
  });
});

describe("assertRegionWritable", () => {
  it("lets an ADMIN write into any region", () => {
    expect(() => assertRegionWritable(admin, "r-us")).not.toThrow();
  });

  it("lets a DEVELOPER write into any region", () => {
    expect(() => assertRegionWritable(developer, "r-us")).not.toThrow();
  });

  it("lets a manager write into their own region", () => {
    expect(() => assertRegionWritable(manager, "r-au")).not.toThrow();
  });

  it("blocks a manager writing into another region", () => {
    expect(() => assertRegionWritable(manager, "r-us")).toThrow(FOREIGN_REGION_ERROR);
  });

  it("blocks a manager with no region from writing anywhere", () => {
    expect(() => assertRegionWritable(managerNoRegion, "r-au")).toThrow(REGION_REQUIRED_ERROR);
  });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run tests/region-scope.test.ts`
Expected: FAIL — `No "regionIdForUser" export is defined on the "../src/lib/scope" mock` or a TypeScript/resolution error naming the missing exports.

- [ ] **Step 3: Write the implementation**

Append to `src/lib/scope.ts` (keep the file dependency-free — `./roles` is the only import it may have):

```ts
/** A viewer whose *region* matters. Distinct from `ScopeUser`, whose
 * ownership scoping never reads a region: widening the shared type would
 * break every existing `{ id, role }` caller and test for no gain. A
 * NextAuth `session.user` satisfies this directly — see
 * src/types/next-auth.d.ts, which puts `regionId` on the session user. */
export type RegionScopeUser = ScopeUser & { regionId: string | null };

/** Message thrown when a manager who has no region tries to write. Surfaced
 * to the user as-is by the actions that catch it. */
export const REGION_REQUIRED_ERROR =
  "No region is assigned to your account. Contact your administrator.";

/** Message thrown when a manager tries to write into another region. Says
 * nothing about which region, or whether it exists. */
export const FOREIGN_REGION_ERROR = "That region is not available to you.";

/** The single region a read should be limited to, or `null` for "every
 * region". An admin resolves to `null` unconditionally — they administer
 * prices across regions and could not do that through a filter.
 *
 * A manager with no region also resolves to `null`, which looks permissive
 * in isolation and is not: such a manager never reaches a page that calls
 * this, because `requireRegion` (src/lib/authz.ts) redirects them first.
 * Callers that need a fail-closed value instead of a routing guarantee want
 * `priceWhereForUser` below, which returns an unmatchable filter for that
 * same user. */
export function regionIdForUser(user: RegionScopeUser): string | null {
  if (isAdminRole(user.role)) return null;
  return user.regionId;
}

/** Restricts a Price query to the viewer's region, or `{}` (no restriction)
 * for an admin. A manager with no region gets `{ regionId: "" }` — an id no
 * row can hold, so the query returns nothing rather than everything. This
 * is the fail-closed half of the pair with `regionIdForUser`: if a routing
 * guard is ever missed, the leak is an empty price list, not another
 * region's prices. */
export function priceWhereForUser(user: RegionScopeUser): { regionId?: string } {
  if (isAdminRole(user.role)) return {};
  return { regionId: user.regionId ?? "" };
}

/** Throws unless `user` may write a row belonging to `regionId`. An admin
 * may write anywhere; a manager may write only their own region, and a
 * manager with no region may write nowhere.
 *
 * Throws rather than returning a boolean so that forgetting to check the
 * result is not a silent authorization bypass — an unused boolean compiles
 * fine, an uncalled guard does not exist. Callers wrap it and return
 * `{ error: message }`; see `createCompany` in src/lib/actions/clients.ts. */
export function assertRegionWritable(user: RegionScopeUser, regionId: string): void {
  if (isAdminRole(user.role)) return;
  if (user.regionId === null) throw new Error(REGION_REQUIRED_ERROR);
  if (user.regionId !== regionId) throw new Error(FOREIGN_REGION_ERROR);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run tests/region-scope.test.ts tests/scope.test.ts`
Expected: PASS — all cases in both files green, and `tests/scope.test.ts` still passing proves `ScopeUser` was not widened.

- [ ] **Step 5: Typecheck**

Run: `npm run typecheck`
Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add src/lib/scope.ts tests/region-scope.test.ts
git commit -m "feat: region scoping helpers alongside the ownership ones"
```

---

## Task 2: Structural test for scope coverage

The safety net. Without it, the next PR that adds a query is one forgotten spread away from a leak, and nothing catches it.

**Files:**
- Test: `tests/scope-coverage.test.ts` (create)

- [ ] **Step 1: Write the test**

Create `tests/scope-coverage.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * A module that queries an ownership- or region-scoped model must import
 * the scoping helpers. This does not prove the helpers are used correctly —
 * only that the author saw them. That is the point: the failure mode this
 * catches is a new query written without the rule in mind at all, which no
 * amount of review catches reliably once the file count grows.
 *
 * Reads files off disk rather than parsing an AST. A regex is enough here
 * because the thing being detected (`db.company.`, `db.document.`,
 * `db.price.`) has exactly one spelling in this codebase, and a false
 * positive costs an allowlist entry with a comment — cheap, and the comment
 * is itself the review artefact worth having.
 */
const ROOTS = ["src/lib/queries", "src/lib/actions"];
const SCOPED_MODEL = /\bdb\.(company|document|price)\b/;
const SCOPE_IMPORT = /from ["']@\/lib\/scope["']/;

/**
 * Files that touch a scoped model and legitimately do not scope it. Each
 * entry needs a reason. Adding one is a deliberate act, which is the whole
 * mechanism — an unexplained entry should not survive review.
 */
const ALLOWLIST = new Map<string, string>([
  [
    "src/lib/actions/catalog/prices.ts",
    "Price mutations are the admin price editor. Every action here is behind requireAdmin(), and an admin is unscoped by definition.",
  ],
  [
    "src/lib/queries/industries.ts",
    "countCompaniesUsingIndustry counts across every owner on purpose — it warns an admin how wide a shared-row rename reaches. Its caller shows the number to admins only; see the client card.",
  ],
]);

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (entry.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

describe("scope coverage", () => {
  const files = ROOTS.flatMap((root) => walk(root));

  it("finds the modules to check at all", () => {
    expect(files.length).toBeGreaterThan(10);
  });

  it("requires a scope import in every module that queries a scoped model", () => {
    const offenders = files.filter((file) => {
      const relative = file.split(path.sep).join("/");
      if (ALLOWLIST.has(relative)) return false;
      const source = readFileSync(file, "utf8");
      return SCOPED_MODEL.test(source) && !SCOPE_IMPORT.test(source);
    });

    expect(offenders).toEqual([]);
  });

  it("keeps the allowlist honest — every entry still touches a scoped model", () => {
    const stale = [...ALLOWLIST.keys()].filter((relative) => {
      const source = readFileSync(relative, "utf8");
      return !SCOPED_MODEL.test(source);
    });

    expect(stale).toEqual([]);
  });
});
```

- [ ] **Step 2: Run it**

Run: `npx vitest run tests/scope-coverage.test.ts`
Expected: PASS. The two allowlisted files are the only current offenders, verified during planning. If a third appears, that file is a real finding — scope it rather than allowlisting it.

- [ ] **Step 3: Prove the test actually bites**

Temporarily add this line to `src/lib/queries/dashboard.ts`, anywhere inside the file:

```ts
// eslint-disable-next-line @typescript-eslint/no-unused-vars
const __probe = () => db.company.findMany({});
```

and temporarily delete its `import { companyWhereForUser, documentWhereForUser, type ScopeUser } from "@/lib/scope";` line.

Run: `npx vitest run tests/scope-coverage.test.ts`
Expected: FAIL, listing `src/lib/queries/dashboard.ts` in `offenders`.

Then revert both edits (`git checkout src/lib/queries/dashboard.ts`) and re-run — expected PASS. A guard never observed failing is not known to work.

- [ ] **Step 4: Commit**

```bash
git add tests/scope-coverage.test.ts
git commit -m "test: fail the build when a query module skips scoping"
```

---

## Task 3: Region is required, and the AU fallback is gone

`createDraft` currently resolves a null `regionId` to region `AU` and copies its currency and tax rate onto the quote. A manager with no region silently produces quotes in the wrong currency.

**Files:**
- Modify: `src/lib/authz.ts`
- Modify: `src/lib/actions/documents/lifecycle.ts:29-53`
- Create: `src/app/(app)/no-region/page.tsx`
- Create: `src/app/(app)/documents/layout.tsx`
- Create: `src/app/(app)/clients/layout.tsx`
- Create: `src/app/(app)/catalog/layout.tsx`

- [ ] **Step 1: Add `requireRegion` to authz**

Append to `src/lib/authz.ts`:

```ts
/**
 * Require a session that is allowed to work with regional data, and hand
 * back the region to work in — `null` for an admin, meaning every region.
 *
 * A manager with no region assigned is redirected to /no-region rather than
 * shown an error: there is nothing for them to do on a Documents, Clients
 * or Catalog page until an admin assigns one, and the previous behaviour
 * (silently falling back to region AU) produced quotes in the wrong
 * currency and tax rate.
 *
 * Call this from the `layout.tsx` of an area that needs a region, not from
 * each page: a new page under that area then inherits the guard instead of
 * having to remember it.
 */
export async function requireRegion(): Promise<{
  session: Session & { user: NonNullable<Session["user"]> };
  regionId: string | null;
}> {
  const session = await requireSession();
  if (isAdminRole(session.user.role)) {
    return { session, regionId: null };
  }
  if (!session.user.regionId) {
    redirect("/no-region");
  }
  return { session, regionId: session.user.regionId };
}
```

- [ ] **Step 2: Create the dead-end screen**

Create `src/app/(app)/no-region/page.tsx`:

```tsx
import type { Metadata } from "next";
import Link from "next/link";
import { PageHeader, SectionCard } from "@/components/ui-kit";

export const metadata: Metadata = { title: "Region not assigned" };
export const dynamic = "force-dynamic";

/**
 * Where `requireRegion` (src/lib/authz.ts) sends a manager with no region.
 * Deliberately a dead end with no retry button: nothing the user can do
 * from here changes the outcome, and offering an action that cannot work is
 * worse than saying so plainly. Account and PathQuote Support stay
 * reachable from the nav, which is how they reach someone who can fix it.
 */
export default function NoRegionPage() {
  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="Region not assigned"
        description="Your account is not attached to a region yet."
      />

      <SectionCard title="What this means">
        <p className="text-sm text-slate-600">
          Quotes, clients and catalogue prices all belong to a region, so
          none of them can be shown until an administrator assigns yours.
          Your account and password are unaffected.
        </p>
        <p className="mt-4 text-sm text-slate-600">
          Ask an administrator to set your region, or send them a message
          from{" "}
          <Link
            href="/settings/support"
            className="font-medium text-brand-dark underline underline-offset-4"
          >
            PathQuote Support
          </Link>
          .
        </p>
      </SectionCard>
    </div>
  );
}
```

- [ ] **Step 3: Add the three area guards**

Create `src/app/(app)/documents/layout.tsx`:

```tsx
import type { ReactNode } from "react";
import { requireRegion } from "@/lib/authz";

/**
 * Every quote belongs to a region, so a manager without one is redirected
 * to /no-region before any page under this area renders. Guarding the
 * segment rather than each page means a new sub-route inherits this.
 */
export default async function DocumentsLayout({ children }: { children: ReactNode }) {
  await requireRegion();
  return <>{children}</>;
}
```

Create `src/app/(app)/clients/layout.tsx` with the same body, renaming the function to `ClientsLayout` and the first doc sentence to "Every client company belongs to a region…".

Create `src/app/(app)/catalog/layout.tsx` with the same body, renaming the function to `CatalogLayout` and the first doc sentence to "Catalogue prices are per region…".

- [ ] **Step 4: Remove the AU fallback**

In `src/lib/actions/documents/lifecycle.ts`, replace the body of `createDraft` from the `const region = …` line through the `if (!resolvedRegion)` block with:

```ts
  // No fallback region. This used to resolve a region-less author to AU and
  // copy AU's currency and tax rate onto the quote, which is wrong in every
  // region but AU and silent in all of them. `requireRegion` in the
  // Documents layout redirects such a user before they can reach the button
  // that calls this; the throw is the defence-in-depth behind that guard.
  if (!session.user.regionId) {
    throw new Error(REGION_REQUIRED_ERROR);
  }
  const resolvedRegion = await db.region.findUnique({
    where: { id: session.user.regionId },
  });
  if (!resolvedRegion) {
    throw new Error(REGION_REQUIRED_ERROR);
  }
```

Add `REGION_REQUIRED_ERROR` to the existing `@/lib/scope` import at the top of the file (it already imports `companyWhereForUser, documentWhereForUser` from there). Delete the now-unused `FALLBACK_REGION_CODE` constant and any import of it; run `npm run lint` to confirm nothing else referenced it.

- [ ] **Step 5: Verify**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all pass, no unused-variable warnings for `FALLBACK_REGION_CODE`.

- [ ] **Step 6: Commit**

```bash
git add src/lib/authz.ts src/lib/actions/documents/lifecycle.ts "src/app/(app)/no-region/page.tsx" "src/app/(app)/documents/layout.tsx" "src/app/(app)/clients/layout.tsx" "src/app/(app)/catalog/layout.tsx"
git commit -m "feat: require a region instead of quietly quoting in AU"
```

---

## Task 4: Segment guards on admin-only Settings

Today each admin page calls `notFound()` itself. A new sub-page under an existing section inherits nothing.

**Files:**
- Modify: `src/lib/settings-nav.ts:29`
- Create: seven `layout.tsx` files under `src/app/(app)/settings/`

- [ ] **Step 1: Make Preferences admin-only**

In `src/lib/settings-nav.ts`, change the Preferences entry:

```ts
  { href: "/settings/preferences", label: "Preferences", icon: SlidersHorizontal, adminOnly: true },
```

Then update the `adminOnly` field's doc comment above it, which currently reads "Account and Preferences are open to every signed-in user":

```ts
  /** Account and PathQuote Support are open to every signed-in user; every
   * other section is ADMIN-or-DEVELOPER only (see isAdminRole). Preferences
   * moved here from the open set: its values are business-wide defaults a
   * manager cannot change, and showing them read-only advertised settings
   * that are none of their concern. */
  adminOnly: boolean;
```

- [ ] **Step 2: Add the seven segment guards**

Create `src/app/(app)/settings/users/layout.tsx`:

```tsx
import type { ReactNode } from "react";
import { requireAdmin } from "@/lib/authz";

/**
 * Admin-only segment. The guard lives here rather than in each page so a
 * new sub-route under this section inherits it instead of having to
 * remember its own check. The per-page `notFound()` checks stay as defence
 * in depth — this layout is the thing that makes a *forgotten* one safe.
 */
export default async function SettingsUsersLayout({ children }: { children: ReactNode }) {
  await requireAdmin();
  return <>{children}</>;
}
```

Create the same file, with only the function name changed, at each of:

| Path | Function name |
|---|---|
| `src/app/(app)/settings/regions/layout.tsx` | `SettingsRegionsLayout` |
| `src/app/(app)/settings/preferences/layout.tsx` | `SettingsPreferencesLayout` |
| `src/app/(app)/settings/content/layout.tsx` | `SettingsContentLayout` |
| `src/app/(app)/settings/option-conflict-groups/layout.tsx` | `SettingsOptionConflictGroupsLayout` |
| `src/app/(app)/settings/spec-images/layout.tsx` | `SettingsSpecImagesLayout` |
| `src/app/(app)/settings/import-export/layout.tsx` | `SettingsImportExportLayout` |

- [ ] **Step 3: Simplify the Preferences page**

`src/app/(app)/settings/preferences/page.tsx` currently branches on `isAdmin` to render a read-only variant. With the layout guard, only admins reach it. Delete the `const isAdmin = isAdminRole(session.user.role);` line, delete the read-only branch of the `isAdmin ? … : …` conditional, keep the admin branch unconditionally, and remove the now-unused `isAdminRole` and `auth` imports if nothing else in the file uses them.

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all pass.

- [ ] **Step 5: Manual check**

Sign in as a manager. Confirm:
- The Settings nav shows only Account and PathQuote Support.
- Visiting `/settings/preferences` directly renders the 404 page, not a read-only form.
- Visiting `/settings/users/<any-id>` directly renders the 404 page.

- [ ] **Step 6: Commit**

```bash
git add src/lib/settings-nav.ts "src/app/(app)/settings"
git commit -m "feat: guard admin settings at the segment, and close Preferences"
```

---

## Task 5: Catalogue prices show the viewer's region only

`getProductDetailById` and `getOptionDetailById` build a price row per active region, so a manager reads AU, US and UK prices side by side.

**Files:**
- Modify: `src/lib/queries/catalog.ts:388-417` (`getProductDetailById`), `:459-495` (`getOptionDetailById`)
- Modify: `src/app/(app)/catalog/[seriesId]/[productId]/page.tsx`
- Modify: `src/app/(app)/catalog/options/[optionId]/page.tsx`

- [ ] **Step 1: Narrow the region list inside both queries**

In `src/lib/queries/catalog.ts`, add this helper just above `toRegionPriceRows`:

```ts
/** The regions whose price rows a viewer should see: every active region
 * for an admin (`regionId` null — the price editor needs the full table),
 * or just their own. An unknown region id yields an empty list rather than
 * the full one, so a stale session cannot widen the view. */
function regionsForPriceRows(
  regions: RegionSummary[],
  regionId: string | null
): RegionSummary[] {
  if (regionId === null) return regions;
  return regions.filter((region) => region.id === regionId);
}
```

Change `getProductDetailById`'s signature and its `prices` field:

```ts
export const getProductDetailById = cache(async function getProductDetailById(
  productId: string,
  regionId: string | null
): Promise<ProductDetail | null> {
```

```ts
    prices: toRegionPriceRows(regionsForPriceRows(regions, regionId), product.prices),
```

Do the same for `getOptionDetailById`: add `regionId: string | null` as its second parameter and wrap its `regions` argument the same way.

Note on `cache()`: both are wrapped in React's request-memoizer, which keys on all arguments. Passing the same `regionId` in `generateMetadata` and in the page body keeps them a single query, as today. Passing different values would double the query — so pass the same value in both.

- [ ] **Step 2: Update the product page**

In `src/app/(app)/catalog/[seriesId]/[productId]/page.tsx`, both `generateMetadata` and `ProductEditorPage` call `getProductDetailById(productId)`. Both need the region, and both already resolve `session` in the same `Promise.all`. Restructure each to resolve the session first:

```tsx
  const session = await auth();
  const product = await getProductDetailById(
    productId,
    regionIdForUser({
      id: session?.user?.id ?? "",
      role: session?.user?.role ?? "MANAGER",
      regionId: session?.user?.regionId ?? null,
    })
  );
```

Add `import { regionIdForUser } from "@/lib/scope";` at the top.

The unauthenticated fallback (`role: "MANAGER"`, `regionId: null`) resolves to `regionId: null`, which would show every region — but `AppLayout` already redirects an unauthenticated request to `/login` before this renders, and the `CatalogLayout` guard from Task 3 redirects a region-less manager. This shape exists only to satisfy the types.

- [ ] **Step 3: Update the option page**

Apply the identical change in `src/app/(app)/catalog/options/[optionId]/page.tsx` for `getOptionDetailById`, in both `generateMetadata` and the page body.

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all pass. The typecheck is what proves no call site was missed — both functions now require a second argument.

- [ ] **Step 5: Manual check**

As an admin, open a product: the "Prices by region" card lists every active region, editable. As a manager in AU, open the same product: exactly one row, `AU`, and the input is disabled (`readOnly={!isAdmin}` already handles that).

- [ ] **Step 6: Commit**

```bash
git add src/lib/queries/catalog.ts "src/app/(app)/catalog"
git commit -m "feat: a manager sees catalogue prices for their region only"
```

---

## Task 6: A manager cannot file a client in another region

`createCompany` and `updateCompany` take `regionCode` straight from the form. `/clients/new` and the client card render a picker listing every active region.

**Files:**
- Modify: `src/lib/actions/clients.ts:60-95` (`createCompany`), `:100-130` (`updateCompany`)
- Modify: `src/app/(app)/clients/new/page.tsx`
- Modify: `src/app/(app)/clients/[companyId]/page.tsx`
- Modify: `src/components/clients/company-form.tsx`

- [ ] **Step 1: Enforce it in the actions**

In `src/lib/actions/clients.ts`, add `assertRegionWritable` to the existing `@/lib/scope` import.

In `createCompany`, immediately after the existing region lookup:

```ts
  const region = await db.region.findUnique({ where: { code: parsed.data.regionCode } });
  if (!region) return { error: "Region not found" };

  // The form field is the client's *claim* about which region this company
  // belongs to. This is the check. Hiding the picker for a manager (see
  // /clients/new) is only the UI consequence of this rule, never the rule.
  try {
    assertRegionWritable(session.user, region.id);
  } catch (error) {
    return { error: error instanceof Error ? error.message : "Region not available" };
  }
```

Add the identical block to `updateCompany`, immediately after its own `if (!region) return { error: "Region not found" };` line.

- [ ] **Step 2: Derive the region server-side on the new-company page**

Replace `src/app/(app)/clients/new/page.tsx`'s region resolution. The current line is `const regions = await listActiveRegions();` and the form receives `regions.map(...)` plus `regionCode: regions[0]?.code ?? ""`.

```tsx
import { requireRegion } from "@/lib/authz";
```

```tsx
  const { regionId } = await requireRegion();
  const allRegions = await listActiveRegions();
  // A manager is offered exactly their own region, so there is nothing to
  // choose and CompanyForm renders the field as static text instead of a
  // select. An admin keeps the full list. The server-side rule lives in
  // createCompany (assertRegionWritable); this only stops offering a choice
  // that would be rejected.
  const regions = regionId === null ? allRegions : allRegions.filter((r) => r.id === regionId);
```

Leave the rest of the page as-is: `regionCode: regions[0]?.code ?? ""` now defaults to the manager's own region, and `regions={regions.map((r) => ({ code: r.code, name: r.name }))}` now carries one entry.

- [ ] **Step 3: Same on the client card**

In `src/app/(app)/clients/[companyId]/page.tsx`, the `Promise.all` includes `listActiveRegions()`. Apply the same filter to its result before passing it to `CompanyForm`, using `requireRegion()` for the region id. The page already calls `requireSession()`; replace that call with `requireRegion()` and destructure `{ session, regionId }`, keeping every existing use of `session`.

- [ ] **Step 4: Render one region as text, not a select**

The region field is rendered by `CompanyRegionField` in `src/components/clients/company-fields.tsx`, shared by the full `/clients` form and the builder's inline "+ New company" panel. Make it degrade when there is nothing to choose.

Read that component before editing. It is **controlled**, not uncontrolled: it takes a `binding: CompanyFieldBinding` and reads `binding.values.regionCode`, writes through `binding.set`, and emits a `name="regionCode"` attribute only when `binding.named` is true. The builder's panel passes `named: false` and submits `binding.values` from React state — its submit button is disabled while `companyForm.regionCode` is empty (`client-section.tsx:377`). So the single-region branch must not bypass the binding: it renders the hidden input only in the named case, and otherwise relies on the state the caller already seeded via `defaultRegionCode`.

Insert at the top of `CompanyRegionField`'s body, before the existing `const id = …` line:

```tsx
  // One region means no choice. A select with one option invites a click
  // that can do nothing and implies other regions exist. Render the value
  // instead — but keep feeding the form exactly what the select would have:
  // a `regionCode` input when this binding is named (the /clients form
  // posts FormData), and nothing extra when it is not (the builder submits
  // `binding.values` from state, which its caller already seeded with this
  // same code via `defaultRegionCode`).
  if (regions.length === 1) {
    return (
      <FieldRow label="Region" hint={hint} required={required} className={className}>
        {binding.named && (
          <input type="hidden" name="regionCode" value={regions[0].code} />
        )}
        <span className="text-sm font-medium text-brand-dark">
          {regions[0].name} ({regions[0].code})
        </span>
      </FieldRow>
    );
  }
```

`FieldRow` is already imported in this file. Drop `htmlFor` here — there is no focusable control to point at.

Verify the builder case specifically: `emptyCompanyFields(defaultRegionCode)` in `client-section.tsx:90` seeds `regionCode` from the page's `defaultRegionCode`, so state is already the manager's region and the submit button enables normally. If you find the submit button stuck disabled, this branch has bypassed the binding — that is the bug this step exists to avoid.

- [ ] **Step 5: Verify**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all pass.

- [ ] **Step 6: Manual check — the direct-request case**

This is the check that matters, because the UI no longer offers the wrong value. As a manager in AU, open the browser devtools Network tab, submit the new-company form once, then replay that POST with `regionCode` changed to `US`.

Expected: the response carries `"That region is not available to you."` and no company is created. If a company is created in US, Step 1 is wrong — fix it before continuing.

- [ ] **Step 7: Commit**

```bash
git add src/lib/actions/clients.ts src/components/clients "src/app/(app)/clients"
git commit -m "feat: a manager's clients belong to their own region"
```

---

## Task 7: Same treatment inside the quote builder

`ClientSection` creates a company inline and renders the same region picker.

**Files:**
- Modify: `src/app/(app)/documents/[documentId]/page.tsx:127,185`

- [ ] **Step 1: Narrow the list passed into the builder**

In `src/app/(app)/documents/[documentId]/page.tsx`, `listActiveRegions()` is one of the promises in the page's `Promise.all`, and its result reaches `<ClientSection regions={regions.map(...)} />`.

The page already calls `requireSession()`. Change it to `requireRegion()`, destructure `{ session, regionId }`, keep every existing use of `session`, and filter after the `Promise.all`:

```tsx
  // Same rule as /clients/new: a manager is offered only their own region,
  // so the inline "new company" form in the builder shows it as text. The
  // enforcement is still createCompany's assertRegionWritable.
  const offeredRegions = regionId === null ? regions : regions.filter((r) => r.id === regionId);
```

Pass `offeredRegions` where `regions` was passed to `ClientSection`. `CompanyRegionField` from Task 6 already renders a single region as text, and `ClientSection` uses that same component — no change is needed inside `client-section.tsx`.

`defaultRegionCode={document.regionCode}` stays as-is: a quote's region is fixed at creation from its author's region and no action mutates it, so it already equals the manager's own region.

- [ ] **Step 2: Verify**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all pass.

- [ ] **Step 3: Manual check**

As a manager, open a draft quote, use "new company" inside the client step. The Region row reads as static text showing your region, with no select.

- [ ] **Step 4: Commit**

```bash
git add "src/app/(app)/documents/[documentId]/page.tsx"
git commit -m "feat: the builder's inline company form is region-locked too"
```

---

## Task 8: The industry rename warning stops counting other people's companies

`countCompaniesUsingIndustry` runs an unscoped `db.company.count`, and the client card shows "Used by N companies" to whoever is looking. For a manager, N includes other managers' companies.

Scoping the count would remove the leak but lie: a rename really does affect every company, so a scoped number under-reports the blast radius. Give the admin the number and the manager the warning.

**Files:**
- Modify: `src/lib/queries/industries.ts:12-18`
- Modify: `src/app/(app)/clients/[companyId]/page.tsx:53,110`
- Modify: `src/components/clients/industry-picker.tsx`

- [ ] **Step 1: Document the contract on the query**

In `src/lib/queries/industries.ts`, replace the doc comment on `countCompaniesUsingIndustry`:

```ts
/**
 * How many companies point at an industry, across every owner. Shown in the
 * rename confirmation so a shared-row edit is never silent.
 *
 * ADMIN-ONLY BY CONTRACT. The count is deliberately unscoped — a rename
 * really does reach every company, and a per-owner number would understate
 * that. But it is therefore cross-manager data, so callers must not show it
 * to a MANAGER; see the client card, which passes `usageCount: null` for
 * one and renders a qualitative warning instead. Scoping this to fix the
 * leak would trade a small disclosure for a wrong number, which is worse.
 */
```

- [ ] **Step 2: Pass it only to admins**

In `src/app/(app)/clients/[companyId]/page.tsx`, the count is currently computed as `const industryUsageCount = company.industryId ? await countCompaniesUsingIndustry(company.industryId) : ...`. Guard it:

```tsx
  const industryUsageCount =
    isAdminRole(session.user.role) && company.industryId
      ? await countCompaniesUsingIndustry(company.industryId)
      : null;
```

Add `import { isAdminRole } from "@/lib/roles";` if the file does not already import it.

- [ ] **Step 3: Handle the null in the picker**

In `src/components/clients/industry-picker.tsx`, widen the `usageCount` prop to `number | null` and branch where it renders the rename warning:

```tsx
        {usageCount === null ? (
          <>This industry is shared. Renaming it changes it everywhere.</>
        ) : (
          <>Used by {usageCount} {usageCount === 1 ? "company" : "companies"}. Renaming changes it for all of them.</>
        )}
```

Keep the surrounding markup and styling exactly as it is — only the text node inside the existing warning element changes. If the current copy differs from the `usageCount !== null` branch above, keep the current wording and only add the null branch.

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all pass, including `tests/scope-coverage.test.ts` — `industries.ts` stays allowlisted and its allowlist reason now matches the code.

- [ ] **Step 5: Manual check**

As a manager, open a client with an industry set and start a rename: the confirmation shows the qualitative sentence and no number. As an admin, the same flow still shows the count.

- [ ] **Step 6: Commit**

```bash
git add src/lib/queries/industries.ts src/components/clients/industry-picker.tsx "src/app/(app)/clients/[companyId]/page.tsx"
git commit -m "fix: don't show a manager a company count spanning other owners"
```

---

## Task 9: Account becomes self-service — photo

The avatar editor sits on the dashboard greeting today, with a comment explaining that Settings is "the admin's section". That is no longer true: Account is where a manager manages themselves.

**Files:**
- Modify: `src/app/(app)/settings/page.tsx`
- Modify: `src/app/(app)/page.tsx:55-66`

- [ ] **Step 1: Move the editor into Account**

`src/app/(app)/settings/page.tsx` currently renders three read-only `<dl>` rows and has a doc comment saying "No photo control here on purpose". Replace that comment and add a photo section.

New doc comment:

```tsx
/**
 * The Account section — the one place a user manages themselves: their
 * photo, their password, and a read-only view of the email, role and region
 * an admin controls. Open to every signed-in user (see SettingsNav).
 *
 * The photo control lives here rather than on the dashboard greeting, where
 * it used to sit back when Settings was admin-only. One control, one place.
 * An ADMIN changing *someone else's* photo still does it from
 * /settings/users/[userId] — a different audience and a different action.
 */
```

Add the imports:

```tsx
import { getUser } from "@/lib/queries/users";
import { setUserAvatar } from "@/lib/actions/users";
import { AvatarEditor } from "@/components/users/avatar-editor";
```

Fetch the current row alongside the region (the session carries no image):

```tsx
  const [region, me] = await Promise.all([
    getRegionById(session.user.regionId),
    getUser(session.user.id),
  ]);
```

Add this `SectionCard` above the existing "Account" card:

```tsx
      <SectionCard title="Photo" description="Shown on your quotes and in the app.">
        <AvatarEditor
          name={me?.name ?? null}
          email={session.user.email ?? ""}
          image={me?.image ?? null}
          size={64}
          onSave={setUserAvatar.bind(null, session.user.id)}
        />
      </SectionCard>
```

`setUserAvatar` already re-checks server-side, via `canSetAvatar`, that the caller may write this user's row — it never trusts the bound id. No authorization change is needed here.

- [ ] **Step 2: Remove it from the dashboard**

In `src/app/(app)/page.tsx`, replace the `<AvatarEditor …/>` element inside the greeting with a plain read-only avatar:

```tsx
            <Avatar name={displayName ?? null} email={session.user.email ?? ""} image={me?.image ?? null} size={40} />
```

Import `Avatar` from `@/components/ui-kit` (the users page already imports it from there, so the component exists). Delete the `AvatarEditor` and `setUserAvatar` imports from this file, and delete the stale comment above the element that says this is where a MANAGER changes their own photo.

- [ ] **Step 3: Verify**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all pass, with no unused-import errors in `src/app/(app)/page.tsx`.

- [ ] **Step 4: Manual check**

As a manager, upload a photo from Settings → Account. It appears in the dashboard greeting after the redirect — `setUserAvatar` already calls `revalidateHome()` and `revalidateSettings()`, so no extra revalidation is needed. Clearing the photo works the same way.

- [ ] **Step 5: Commit**

```bash
git add "src/app/(app)/settings/page.tsx" "src/app/(app)/page.tsx"
git commit -m "feat: a user changes their own photo from Account"
```

---

## Task 10: Account becomes self-service — password

A manager currently cannot change their own password at all; only an admin can, via `setUserPassword(userId, …)`.

The new action is deliberately **not** a relaxation of `setUserPassword`. It is a second action that takes no `userId`, so there is no id for a caller to substitute.

**Files:**
- Modify: `src/lib/actions/users.ts`
- Create: `src/components/users/change-own-password-form.tsx`
- Modify: `src/app/(app)/settings/page.tsx`

No new unit test. `changeOwnPassword` reuses `setUserPasswordSchema`, whose bounds are already covered by `tests/users-validation.test.ts`, and the only thing new here — that the action writes `session.user.id` and takes no target id — is a property of its signature, which the type checker enforces and a test could not add to. The behaviour that matters is checked manually in Step 5 and adversarially in Task 11.

- [ ] **Step 1: Add the action**

In `src/lib/actions/users.ts`, add below `setUserPassword`:

```ts
/**
 * Sets the *signed-in* user's own password. Separate from `setUserPassword`
 * above rather than a relaxation of it, and the difference is the point:
 * this takes no `userId`. There is no id for a caller to substitute,
 * because the only id it can ever write is `session.user.id`, read on the
 * server. `setUserPassword` keeps its `requireAdmin` and its explicit
 * target; the two never share a code path.
 *
 * The current password is not required. This is a deliberate product
 * decision: the session cookie is already the proof of identity, and a
 * stolen live session can change the password either way — asking for the
 * old one adds friction without adding a barrier. Revisit only alongside
 * session invalidation on password change, which would make it meaningful.
 */
export async function changeOwnPassword(formData: FormData): Promise<ActionResult> {
  const session = await requireSession();

  const parsed = setUserPasswordSchema.safeParse({ password: formData.get("password") });
  if (!parsed.success) {
    return { error: flattenZodError(parsed.error) };
  }

  const passwordHash = await hash(parsed.data.password);
  await db.user.update({
    where: { id: session.user.id },
    data: { passwordHash },
  });

  revalidateUserPaths(session.user.id);
  return {};
}
```

Every identifier used here — `requireSession`, `setUserPasswordSchema`, `flattenZodError`, `hash`, `db`, `revalidateUserPaths`, `ActionResult` — is already imported at the top of this file by `setUserPassword` and its neighbours. Add no new imports.

- [ ] **Step 2: Add the form component**

Create `src/components/users/change-own-password-form.tsx`:

```tsx
"use client";

import { SetPasswordForm } from "@/components/users/set-password-form";
import type { ActionResult } from "@/lib/actions/users";

/**
 * The Account card's "change my password" control. A thin wrapper over
 * `SetPasswordForm` — same single field, same transition+toast behaviour,
 * same "no confirmation field" decision (a typo just means changing it
 * again). It exists as its own component only so the Account page names
 * what it is rendering, and so the two call sites can diverge later without
 * one of them silently inheriting the other's copy.
 */
export function ChangeOwnPasswordForm({
  action,
}: {
  action: (formData: FormData) => Promise<ActionResult>;
}) {
  return <SetPasswordForm action={action} />;
}
```

- [ ] **Step 3: Render it on Account**

In `src/app/(app)/settings/page.tsx`, add the imports:

```tsx
import { changeOwnPassword } from "@/lib/actions/users";
import { ChangeOwnPasswordForm } from "@/components/users/change-own-password-form";
```

and add this card below the existing "Account" card:

```tsx
      <SectionCard
        title="Password"
        description="At least 10 characters. You stay signed in after changing it."
      >
        <ChangeOwnPasswordForm action={changeOwnPassword} />
      </SectionCard>
```

- [ ] **Step 4: Verify**

Run: `npm run typecheck && npm run lint && npm test`
Expected: all pass.

- [ ] **Step 5: Manual check**

As a manager: set a password shorter than 10 characters — an inline error appears and nothing is saved. Set a valid one — a success toast appears and the field clears. Sign out, sign back in with the new password. Then confirm from an admin account that `/settings/users/<that user>` still offers the admin's own set-password form and that it still works.

- [ ] **Step 6: Commit**

```bash
git add src/lib/actions/users.ts src/components/users/change-own-password-form.tsx "src/app/(app)/settings/page.tsx"
git commit -m "feat: a user changes their own password from Account"
```

---

## Task 11: Cross-manager integration check

Everything above is enforced at a call site or a guard. This task is the adversarial pass that proves it, because the requirement is about what is *impossible*, and no unit test demonstrates impossibility.

This is a manual scripted check, not an automated test: the suite has no database and adding one for this would be a larger change than the feature.

**Files:**
- Modify: `docs/runbook.md`

- [ ] **Step 1: Prepare two managers**

Using `npm run user:create`, create manager A in region AU and manager B in region US (or two managers both in AU — run the whole check twice, once same-region and once cross-region; the same-region pass is the one that proves ownership scoping, and it is the one most likely to regress).

As A, create: one company, one contact on it, one draft quote with at least one item.

Record A's company id, contact id, document id, and document item id from the URLs and from devtools.

- [ ] **Step 2: Run the checks as B**

Signed in as B, attempt each of these and record the result:

| # | Attempt | Expected |
|---|---|---|
| 1 | Visit `/clients/<A's company id>` | 404 page |
| 2 | Visit `/documents/<A's document id>` | 404 page |
| 3 | Visit `/documents/<A's document id>/quotation` | 404 page |
| 4 | `GET /api/documents/<A's document id>/quotation-pdf` | 404 or 401, never a PDF |
| 5 | Replay `updateCompany` with A's company id | `NOT_FOUND_ERROR` message, no change |
| 6 | Replay a `documents/items` action with A's item id | `NOT_FOUND_ERROR` message, no change |
| 7 | Replay `createCompany` with A's region code (cross-region run only) | "That region is not available to you." |
| 8 | Visit `/settings/users` and `/settings/preferences` | 404 page for both |
| 9 | Open any product page | exactly one price row, B's region |

Any 403 in place of a 404 is a finding, not a pass: it confirms the row exists. Any 200 is a leak — stop and fix before continuing.

- [ ] **Step 3: Check the region-less case**

As an admin, clear B's region (`/settings/users/<B>`, set region to none). As B, visit `/documents`, `/clients` and `/catalog`.

Expected: each redirects to `/no-region`. `/settings` (Account) and `/settings/support` still work. Restore B's region afterwards.

- [ ] **Step 4: Record the outcome in the runbook**

Add to `docs/runbook.md`:

```markdown
## Manager isolation

A MANAGER sees only the clients and quotes they created, and only their own
region's catalogue prices. Two rules make that true operationally:

- **Every manager needs a region.** A manager with no region assigned is
  redirected to /no-region and can reach only Account and PathQuote Support.
  Assign the region when creating the account. There is no fallback region:
  quotes used to silently default to AU's currency and tax rate, and no
  longer do.
- **Catalogue visibility is per user, and defaults to "sees everything".**
  Hiding a product from a manager is done from /settings/users/<id>, one
  user at a time. A newly created manager sees the whole catalogue until
  someone hides what should be hidden — deliberate (the exception is rare),
  but it means an admin creating an account in a region with hidden products
  must set that up by hand.

The adversarial check for this is in
`docs/superpowers/plans/2026-09-06-manager-permissions.md`, Task 11. Re-run
it after any change to `src/lib/scope.ts`, `src/lib/authz.ts`, or the
Settings layout guards.
```

- [ ] **Step 5: Commit**

```bash
git add docs/runbook.md
git commit -m "docs: runbook entry for manager isolation and its checks"
```

---

## Task 12: Final verification

- [ ] **Step 1: Full suite**

Run: `npm test`
Expected: every test passes, including `tests/scope.test.ts`, `tests/region-scope.test.ts` and `tests/scope-coverage.test.ts`.

- [ ] **Step 2: Types and lint**

Run: `npm run typecheck && npm run lint`
Expected: clean.

- [ ] **Step 3: Build**

Run: `npm run build`
Expected: succeeds. This is what catches a server component importing something client-only, which the unit tests cannot see.

- [ ] **Step 4: Review the diff against the spec**

Run: `git diff main --stat` and read `docs/superpowers/specs/2026-09-06-manager-permissions-design.md` alongside it. Every hole listed under "Holes to close" should map to a commit. Nothing under "Out of scope" should appear in the diff — in particular, no tooling for copying catalogue visibility between users, and no re-scoping of `CatalogVisibility` to region.

- [ ] **Step 5: Use the finishing-a-development-branch skill**

Invoke `superpowers:finishing-a-development-branch` to decide how this integrates.
