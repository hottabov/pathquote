// Pure scoping helpers: given the current user (id + role + region), return
// the Prisma `where` fragment that restricts a query to what that user is
// allowed to see. ADMIN (and DEVELOPER — see isAdminRole) sees everything
// (an empty filter); REGIONAL_MANAGER sees their whole region;
// MANAGER is restricted to their own companies/documents (spec §6). Kept
// dependency free (no `@/lib/db` import) so these are trivially
// unit-testable and safe to import from both server actions/queries and
// plain tests.
//
// Three functions here decide which clients a user touches, and they are not
// interchangeable. Every query and every mutating action spreads one of them
// into its `where` (see src/lib/actions/documents/*.ts,
// src/lib/actions/clients.ts), loading the row it is about to change through
// the same filter it reads with. So widening a filter widens editing too, and
// that is deliberate for REGIONAL_MANAGER -- it may edit, finalize, unfinalize
// and delete drafts in its region, decided by Vadym 2026-09-22. Anything a
// regional manager must NOT do is gated on `isAdminRole` at its own call
// site, not here.
//
//   companyWhereForUser       READ and EDIT clients. Ownership (or region),
//                             plus any country the user has been granted.
//                             The widest of the two company filters.
//   companyOwnedWhereForUser  DELETE clients, and nothing else. Ownership (or
//                             region) only; a country grant never reaches it.
//   documentWhereForUser      READ and WRITE quotes. Unrelated to countries.
//
// Why delete has its own filter (decision D2, 2026-10-08): a country grant
// exists so a manager can find and keep correct the ~8,800 clients imported
// from ACT!, none of which has an owner. Fixing an address is a daily act and
// is cheap to undo. Deleting a client is rare and cannot be undone, and the
// imported companies are exactly the ones at risk -- `Document.company` is
// `onDelete: Restrict`, so only a company with no quotes can be deleted, and
// that is most of them. A grant that is broad on purpose (one manager holds
// "*") must therefore not become permission to remove a client the manager
// does not look after. If a new action deletes a company or a contact, it
// belongs on `companyOwnedWhereForUser`, and the compiler will not tell you.

import { isAdminRole, isRegionalManagerRole } from "./roles";

/** The `visibleCountries` value that grants every country. An empty list is
 * the opposite -- no grant -- and must never be read as "all": the column
 * defaults to `[]`, so that reading would hand every new user the whole client
 * base. Exported so the script that writes grants and the tests that read
 * them use the same spelling. */
export const ALL_COUNTRIES = "*";

/** A viewer whose rows are being scoped. `regionId` is optional so every
 * existing `{ id, role }` caller and test still type-checks; it is read only
 * for a REGIONAL_MANAGER, and a missing one fails closed (see below).
 * `visibleCountries` is optional for the same reason, and a missing one fails
 * closed the same way: no country arm, which leaves exactly the ownership
 * (or region) rule. A NextAuth `session.user` satisfies this directly -- see
 * src/types/next-auth.d.ts. */
export type ScopeUser = {
  id: string;
  role: string;
  regionId?: string | null;
  visibleCountries?: string[];
};

/** What `companyOwnedWhereForUser` may return: an owner id (MANAGER), an
 * owner region (REGIONAL_MANAGER), or nothing at all (admin). */
export type CompanyOwnedScopeWhere = { ownerId?: string; owner?: { regionId: string } };

/** What `companyWhereForUser` may return: anything `CompanyOwnedScopeWhere`
 * can (an owner id, an owner region, or nothing), or -- for a user holding a
 * country grant -- an `OR` of that ownership rule and `country IN (grant)`.
 * Named so the shapes are visible at the call sites that spread it. The two
 * never combine: `OR` is present only on its own. */
export type CompanyScopeWhere = CompanyOwnedScopeWhere & {
  OR?: [CompanyOwnedScopeWhere, { country: { in: string[] } }];
};

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

/** The countries `user` has been granted, with anything that is not a
 * non-empty string dropped. Blank entries go because `country IN ('')` would
 * match a company whose country was saved as an empty string, and a grant
 * that is nothing but blanks is no grant at all. A missing or non-array value
 * (an old session token, a hand-built user) is the empty grant. */
function grantedCountries(user: ScopeUser): string[] {
  const raw: unknown = user.visibleCountries;
  if (!Array.isArray(raw)) return [];
  return raw.filter((code): code is string => typeof code === "string" && code.trim() !== "");
}

/** Restricts a Company query to the clients `user` OWNS -- or, for a
 * REGIONAL_MANAGER, the clients owned by a user of their region -- and ignores
 * any country grant. Every company for an admin (`{}`). Spread this into a
 * Prisma `where` object, merging with any other filters the caller applies.
 *
 * This is the DELETE filter: `deleteCompany` and `deleteContact` use it and
 * nothing else should. See the header comment for why deleting is narrower
 * than editing. It is also the ownership arm that `companyWhereForUser` ORs a
 * country grant onto, so the two cannot drift apart.
 *
 * A regional manager's filter goes through the `owner` relation because
 * `Company` deliberately has no region of its own (see the comment on
 * `model Company` in prisma/schema.prisma): a client belongs to the business
 * and to the manager who looks after them, not to an office -- an Australian
 * manager sells into Europe and that European buyer is still their client.
 * So "this region's clients" can only mean "owned by a user of this region",
 * and two consequences follow, both intended:
 *   - a company with no owner (`ownerId` null) matches no regional manager
 *     and stays admin-only;
 *   - handing a leaver's clients to another manager (`reassignUserCompanies`,
 *     src/lib/actions/users.ts) moves them between regional views
 *     automatically, with no second column to keep in step -- but blanking a
 *     departed manager's own `regionId` hides their clients from their
 *     region's manager. Deactivate the account; leave its region alone.
 */
export function companyOwnedWhereForUser(user: ScopeUser): CompanyOwnedScopeWhere {
  if (isAdminRole(user.role)) return {};
  if (isRegionalManagerRole(user.role)) return { owner: { regionId: regionalScopeId(user) } };
  return { ownerId: user.id };
}

/** Restricts a Company query to the clients `user` may READ and EDIT: the
 * ones `companyOwnedWhereForUser` allows, plus every company whose `country`
 * is one the user has been granted (`User.visibleCountries`). Spread this into
 * a Prisma `where` object, merging with any other filters the caller applies.
 *
 * The country arm is purely additive (decision D1, 2026-10-08): nothing a
 * manager could see before is taken away, and a regional manager keeps its
 * region arm. That matters because the ACT! import left every company without
 * an owner -- the ownership rule alone shows a manager none of them.
 *
 *   - admin                        `{}`
 *   - no grant (empty or absent)   exactly `companyOwnedWhereForUser`
 *   - grant of one or more codes   `{ OR: [<ownership rule>, { country: { in } }] }`
 *   - grant containing `"*"`       `{}` -- every country, which for a manager
 *                                  is the same read/edit view an admin has.
 *                                  Delete is unaffected; see the header.
 *
 * An EMPTY grant is not "all". `User.visibleCountries` defaults to `[]`, so
 * treating that as a wildcard would show every new user the entire client
 * base. The wildcard is the explicit `"*"` and nothing else.
 *
 * `country IN (...)` compares exactly, and `Company.country` is only
 * guaranteed to be an ISO alpha-2 code for rows written since the ISO
 * migration (see the schema comment): a legacy free-text company does not
 * match a grant of its country until it is normalised. That is the safe
 * direction -- it hides a row rather than showing one to the wrong person.
 */
export function companyWhereForUser(user: ScopeUser): CompanyScopeWhere {
  if (isAdminRole(user.role)) return {};

  const owned = companyOwnedWhereForUser(user);
  const countries = grantedCountries(user);
  if (countries.length === 0) return owned;
  if (countries.includes(ALL_COUNTRIES)) return {};

  return { OR: [owned, { country: { in: countries } }] };
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
