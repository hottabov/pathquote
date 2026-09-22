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
 * in isolation and is not: such a manager never *renders* a page that calls
 * this, because `requireRegion` (src/lib/authz.ts) redirects them first.
 * "Renders", not "reaches", is the precise claim — Next starts a layout and
 * its page in parallel, so a page's data fetch can begin before the
 * layout's `redirect()` aborts the response. Nothing reaches a user either
 * way, but do not read this as a guarantee that the call never executes.
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

/** The same answer `priceWhereForUser` gives, as a bare region id for a
 * caller that filters a list in memory rather than building a Prisma
 * `where` — `null` means "every region" (admin only).
 *
 * Exists as its own export purely so the unwrap below is testable. `??`
 * substitutes only for null/undefined, so the `""` a region-less viewer
 * gets survives it and narrows the list to nothing; `||` in its place would
 * collapse `""` to `null` and show that viewer EVERY region. One operator
 * separates fail-closed from fail-open, and it is now pinned by a test
 * rather than living inside a module the no-database suite cannot import
 * (src/lib/authz.ts reaches @/auth). See `priceRegionIdForSessionUser`
 * there for the session-shaped adapter over this. */
export function priceRegionIdForUser(user: RegionScopeUser): string | null {
  return priceWhereForUser(user).regionId ?? null;
}

/** Throws unless `user` may write a row belonging to `regionId`. An admin
 * may write anywhere; a manager may write only their own region, and a
 * manager with no region may write nowhere.
 *
 * Throws rather than returning a boolean so that ignoring the *result* is
 * not a silent authorization bypass: `assertRegionWritable(user, id);` as a
 * bare statement compiles fine under this tsconfig if it returns a boolean,
 * and reads exactly like a check that happened. This does nothing about
 * forgetting to call it at all — that is what the structural test in
 * tests/scope-coverage.test.ts is for. Callers wrap it and return
 * `{ error: message }`; see `createCompany` in src/lib/actions/clients.ts.
 *
 * Falsy rather than `=== null` on the region: `interface User` in
 * src/types/next-auth.d.ts declares `regionId` optional, so an untyped or
 * cast caller can hand this `undefined`. That was already fail-closed, but
 * it reported FOREIGN_REGION_ERROR — the wrong reason, which sends the user
 * to fix the wrong thing. */
export function assertRegionWritable(user: RegionScopeUser, regionId: string): void {
  if (isAdminRole(user.role)) return;
  if (!user.regionId) throw new Error(REGION_REQUIRED_ERROR);
  if (user.regionId !== regionId) throw new Error(FOREIGN_REGION_ERROR);
}
