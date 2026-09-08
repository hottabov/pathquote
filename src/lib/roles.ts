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
