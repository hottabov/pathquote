// Single source of truth for "is this an admin?" across the app.
//
// DEVELOPER carries the exact same rights as ADMIN almost everywhere (see the
// Role enum's own comment in schema.prisma) -- historically the only thing
// distinguishing it was that the support form addresses its message to
// whoever holds it (see src/lib/actions/support.ts). Every place that used to
// compare a role against the literal "ADMIN" now calls this instead, so the
// next role that should carry admin rights is one line here, not a fresh grep
// across the whole tree.
//
// One exception now exists: deleting a SIGNED quote (`canDeleteDocument`,
// src/lib/signing/state.ts) is DEVELOPER-only, a right ADMIN does not have.
// See `isDeveloperRole` below for why that needed its own predicate rather
// than folding into this one.
//
// Deliberately typed against a bare `string` rather than Prisma's generated
// `Role` (or a local role-union type): callers pass this a session's Role
// enum value, a plain string column, a zod-parsed literal union, or a form
// field -- all of those satisfy `string` with no import needed, and this
// file stays dependency-free (no `@/lib/db`, no `@prisma/client`) so it's
// safely importable from pure validation modules and their unit tests.
/** Every value of Prisma's `Role` enum. Hand-maintained rather than imported
 * from `@prisma/client`, for the same reason everything else in this file is
 * typed against a bare `string`: this module must stay importable from pure
 * validation modules and from the no-database test suite.
 *
 * Hand-maintained means it can drift, so `tests/role-parity.test.ts` reads the
 * enum out of `prisma/schema.prisma` and fails if this list, that enum and
 * `userRoleSchema` (src/lib/validation/users.ts) stop agreeing. Adding a role
 * to any one of the three and not the others is a test failure, not a
 * surprise in production. The set is compared unordered: this list and the
 * schema deliberately differ in order from the database's own (see the `Role`
 * enum's comment in prisma/schema.prisma). */
export const ROLE_VALUES = ["ADMIN", "MANAGER", "REGIONAL_MANAGER", "DEVELOPER"] as const;

const ADMIN_ROLES: ReadonlySet<string> = new Set(["ADMIN", "DEVELOPER"]);

/** True for ADMIN and DEVELOPER, false for MANAGER (or anything else). */
export function isAdminRole(role: string | null | undefined): boolean {
  return role != null && ADMIN_ROLES.has(role);
}

/**
 * True for DEVELOPER only, false for ADMIN, MANAGER, or anything else.
 *
 * A separate predicate rather than a bare `role === "DEVELOPER"` comparison
 * at the one call site that needs it (`canDeleteDocument`,
 * src/lib/signing/state.ts): DEVELOPER-only rights are new and, per this
 * file's header comment, meant to stay rare, but "rare" is not "one and
 * done" -- the next one should be a single line added here, the same way
 * the next admin-equivalent right is a single line in `isAdminRole`, rather
 * than a fresh string comparison (and a fresh grep to find its siblings)
 * wherever it happens to be needed.
 *
 * Same dependency-free, bare-`string` style as `isAdminRole` above, for the
 * same reason: importable from pure validation modules and their tests with
 * no Prisma import.
 */
export function isDeveloperRole(role: string | null | undefined): boolean {
  return role === "DEVELOPER";
}

/**
 * True for REGIONAL_MANAGER only.
 *
 * A REGIONAL_MANAGER has every MANAGER right, plus a read AND write scope
 * widened from "my own rows" to "my region's rows" -- every quote whose
 * `Document.regionId` is their region, and every client owned by a user of
 * their region. That widening lives entirely in `companyWhereForUser` and
 * `documentWhereForUser` (src/lib/scope.ts), which every query and every
 * mutating action already routes through, so this predicate has exactly two
 * callers there and needs none elsewhere.
 *
 * Deliberately NOT folded into `isAdminRole`. The rights gated on that
 * predicate are cross-region and structural -- editing the catalogue,
 * creating regions and industries, administering users, importing/exporting,
 * uploading files, deleting a signed quote -- and a regional manager has none
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
 * This is a presentation rule, not an authorization one -- the rows a viewer
 * gets are decided by `documentWhereForUser` (src/lib/scope.ts), and a
 * MANAGER's rows are all their own whether or not this returns true. It
 * lives here rather than in the page so the same question has one answer if
 * the clients list ever asks it too.
 */
export function canSeeSalesperson(role: string | null | undefined): boolean {
  return role != null && SALESPERSON_COLUMN_ROLES.has(role);
}

/**
 * Whether this viewer gets the ACT! sync section at all -- the nav row, the
 * page at /settings/act-sync, and the Sync now button's action. True for an
 * ADMIN or DEVELOPER whatever their own flag says, and for anybody else
 * exactly when an admin has ticked `User.actSyncVisible` for them.
 *
 * Why the role short-circuits rather than being another thing to tick: an
 * admin whose own flag was off would have hidden from themselves the page
 * where the flag is set -- not literally (the control is on a Users page,
 * which is admin-only anyway) but in the way that matters, by making the
 * checkbox look like something that could lock an administrator out. It
 * cannot. This is also what makes the checkbox meaningless on an ADMIN's or
 * DEVELOPER's own page, which is why that page explains itself there instead
 * of offering a control that would do nothing (see
 * src/app/(app)/settings/users/[userId]/page.tsx).
 *
 * Why the flag defaults to false is the column's own story -- see
 * `actSyncVisible` in prisma/schema.prisma. The short version: the users this
 * app is growing into are distributors with no ACT! access, and hiding them by
 * default costs a real new manager one tick.
 *
 * Takes an object rather than two positional arguments because the two are a
 * role string and a boolean, which is exactly the pair a call site can swap
 * without the compiler noticing. Same dependency-free style as its siblings
 * above, so `settings-nav.ts` (pure, unit-tested without a database) and
 * `authz.ts` (which has one) can both reach the one decision rather than
 * writing it twice and drifting.
 */
export function canSeeActSync(viewer: {
  role: string | null | undefined;
  actSyncVisible: boolean;
}): boolean {
  return isAdminRole(viewer.role) || viewer.actSyncVisible;
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

