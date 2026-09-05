// Pure zod validation (+ a pure business-logic helper) for the user
// administration screens (/settings/users). No imports from `@/lib/db`,
// `@prisma/client`, or any Prisma-generated types — this module must be
// safely importable from a plain unit test and from the server actions that
// call it (see src/lib/actions/users.ts). Mirrors the style of
// src/lib/validation/clients.ts and src/lib/validation/content.ts.
import { z } from "zod";
import { isAdminRole } from "@/lib/roles";
import { userRegionCodeSchema } from "./region-code";

// --- field pieces ----------------------------------------------------------

/** Normalized (trimmed, lowercased) email, ≤200 chars — mirrors the
 * normalization `auth.ts`'s Credentials provider applies at login, so a
 * user created here can always be found by a case-insensitive-typed email
 * later. */
export const userEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(200, "Email must be at most 200 characters")
  .pipe(z.email("Must be a valid email address"));

/** Optional display name, ≤120 chars. Missing/blank collapses to
 * `undefined` (stored as `null`) — same preprocess pattern as every other
 * optional-text field in this app (see src/lib/validation/clients.ts). */
export const userNameSchema = z.preprocess(
  (value) =>
    value === null || value === undefined || (typeof value === "string" && value.trim() === "")
      ? undefined
      : value,
  z.string().trim().max(120, "Name must be at most 120 characters").optional()
);

/** Optional phone number, ≤40 chars (matches the reference Word template's
 * "Prepared by: <manager name / phone>, <email>" block — see
 * DocSheetPreparedBy in src/lib/sheet-data.ts). Missing/blank collapses to
 * `undefined` (stored as `null`), same preprocess pattern as
 * `userNameSchema`. Not validated against a phone-number format — like
 * `Contact.phone` elsewhere in this app, it's free text (country-specific
 * formatting, extensions, etc.). */
export const userPhoneSchema = z.preprocess(
  (value) =>
    value === null || value === undefined || (typeof value === "string" && value.trim() === "")
      ? undefined
      : value,
  z.string().trim().max(40, "Phone must be at most 40 characters").optional()
);

/** Mirrors Prisma's `Role` enum (prisma/schema.prisma) without importing
 * `@prisma/client` here — see the file header for why. */
export const userRoleSchema = z.enum(["ADMIN", "MANAGER", "DEVELOPER"]);
export type UserRoleInput = z.infer<typeof userRoleSchema>;

/** A region code, or `null` for "no region assigned" — the nullable variant
 * of the shared rule, re-exported from ./region-code (where its doc comment
 * lives) so src/lib/actions/users.ts keeps importing it from here. */
export { userRegionCodeSchema };

/** Optional initial/replacement password: missing/blank means "leave the
 * user on magic-link-only sign-in" (create) or "don't change it" (set new
 * password re-uses this same schema, but there blank is filtered out by the
 * caller before it ever reaches a schema — see setUserPassword). 10-200
 * chars, matching the spec's "≥10 chars" floor. */
export const userPasswordSchema = z.preprocess(
  (value) =>
    value === null || value === undefined || (typeof value === "string" && value.trim() === "")
      ? undefined
      : value,
  z
    .string()
    .min(10, "Password must be at least 10 characters")
    .max(200, "Password must be at most 200 characters")
    .optional()
);

/** Same bound as `userPasswordSchema` but required — used by
 * `setUserPassword`, which only ever runs when the admin actually typed a
 * new password (an empty submission there is a caller error, not a valid
 * "no-op"). */
export const requiredPasswordSchema = z
  .string()
  .min(10, "Password must be at least 10 characters")
  .max(200, "Password must be at most 200 characters");

// --- forms -------------------------------------------------------------

export const createUserSchema = z.object({
  email: userEmailSchema,
  name: userNameSchema,
  phone: userPhoneSchema,
  role: userRoleSchema,
  regionCode: userRegionCodeSchema,
  password: userPasswordSchema,
});
export type CreateUserInput = z.infer<typeof createUserSchema>;

export const updateUserSchema = z.object({
  name: userNameSchema,
  phone: userPhoneSchema,
  role: userRoleSchema,
  regionCode: userRegionCodeSchema,
  active: z.preprocess(
    (value) => value === "on" || value === true || value === "true" || value === "1",
    z.boolean()
  ),
});
export type UpdateUserInput = z.infer<typeof updateUserSchema>;

export const setUserPasswordSchema = z.object({
  password: requiredPasswordSchema,
});
export type SetUserPasswordInput = z.infer<typeof setUserPasswordSchema>;

// --- last-admin / self-modification safeguards ------------------------------

/** The minimal shape `canModifyUser` needs for the user being changed —
 * deliberately not typed against Prisma's generated `User` payload so this
 * stays trivial to unit test with hand-built fixtures (mirrors
 * `FinalizableDocument` in src/lib/validation/finalize.ts). */
export type ModifiableUser = {
  id: string;
  role: UserRoleInput;
  active: boolean;
};

/** The subset of an update actually being applied — `undefined` for a field
 * means "leave it as-is" (e.g. `updateUser` always sends both `role` and
 * `active`, but a helper caller that only toggles one can omit the other). */
export type UserChanges = {
  role?: UserRoleInput;
  active?: boolean;
};

/**
 * Returns a human-readable reason `actorId` may not apply `changes` to
 * `target`, or `null` when the change is allowed. `activeAdminCount` is the
 * number of currently-active admin-rights users (ADMIN or DEVELOPER — see
 * `isAdminRole`) in the whole system (computed by the caller with a
 * `db.user.count` *before* the change is applied — see
 * `requireModifiableUser` in src/lib/actions/users.ts), which must include
 * `target` itself if `target` currently holds admin rights and is active.
 *
 * Two independent safeguards, checked in this order so a caller only ever
 * sees one actionable message:
 *   1. **Self-modification**: an admin (or developer) can never deactivate
 *      their own account or strip their own admin rights, even if other
 *      admins exist — this isn't about running out of admins, just
 *      preventing someone from locking themselves out of the one page that
 *      could undo it.
 *   2. **Last active admin**: whether or not it's the actor's own account,
 *      the system's only remaining user with admin rights can't be
 *      deactivated or demoted to MANAGER — that would leave nobody able to
 *      reach this page at all.
 *
 * Pure and synchronous by design (no `@/lib/db` import) so both the action
 * and its unit tests (tests/users-validation.test.ts) can exercise every
 * branch without a database.
 */
export function canModifyUser(
  actorId: string,
  target: ModifiableUser,
  changes: UserChanges,
  activeAdminCount: number
): string | null {
  const isSelf = actorId === target.id;

  if (isSelf && changes.active === false) {
    return "You can't deactivate your own account";
  }
  if (isSelf && isAdminRole(target.role) && changes.role !== undefined && !isAdminRole(changes.role)) {
    return "You can't remove your own admin role";
  }

  const targetIsActiveAdmin = isAdminRole(target.role) && target.active;
  if (targetIsActiveAdmin && activeAdminCount <= 1) {
    if (changes.active === false) {
      return "Can't deactivate the last active admin";
    }
    if (changes.role !== undefined && !isAdminRole(changes.role)) {
      return "Can't demote the last active admin";
    }
  }

  return null;
}

// --- avatar authorization ---------------------------------------------------

/**
 * Whether `actorId` (signed in as `actorRole`) may set `targetId`'s avatar
 * (`User.image` — see src/lib/actions/users.ts's `setUserAvatar`): an ADMIN
 * may set anyone's, a MANAGER only their own. Pure and synchronous — same
 * reasoning as `canModifyUser` above — so both `setUserAvatar` and its unit
 * tests can exercise every branch without a database. `actorId`/`targetId`
 * must always be the *session's* user id and the target user id
 * respectively; a caller must never derive either from client-submitted
 * form data it doesn't already trust.
 */
export function canSetAvatar(actorId: string, actorRole: UserRoleInput, targetId: string): boolean {
  return isAdminRole(actorRole) || actorId === targetId;
}
