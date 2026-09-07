"use server";

import {
  revalidateHome,
  revalidateSettings,
  revalidateUser,
  revalidateUserList,
} from "@/lib/revalidate";
import { redirect } from "next/navigation";
import { Prisma } from "@prisma/client";
import { hash } from "@node-rs/argon2";
import { db } from "@/lib/db";
import { requireAdmin, requireSession } from "@/lib/authz";
import { idSchema } from "@/lib/validation/documents";
import {
  createUserSchema,
  updateUserSchema,
  setUserPasswordSchema,
  canModifyUser,
  canSetAvatar,
} from "@/lib/validation/users";
import { countActiveAdmins } from "@/lib/queries/users";
import { IMAGE_URL_PATTERN, saveUpload } from "@/lib/uploads";
import { parseSignatureDataUrl } from "@/lib/signing/data-url";
import { NOT_FOUND_ERROR, flattenZodError, type ActionResult } from "./_shared";

export type { ActionResult };

const EMAIL_EXISTS_ERROR = "That email already exists — choose a different one.";

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002";
}

function readCreateUserForm(formData: FormData) {
  return {
    email: formData.get("email"),
    name: formData.get("name"),
    phone: formData.get("phone"),
    role: formData.get("role"),
    regionCode: formData.get("regionCode"),
    password: formData.get("password"),
  };
}

function readUpdateUserForm(formData: FormData) {
  return {
    name: formData.get("name"),
    phone: formData.get("phone"),
    role: formData.get("role"),
    regionCode: formData.get("regionCode"),
    active: formData.get("active"),
  };
}

/** Resolves a region code to its id, or `null` for "no region assigned".
 * Returns `{ error }` if a non-null code doesn't match an existing region —
 * mirrors `resolveRegionId` in src/lib/actions/content.ts. */
async function resolveRegionId(
  regionCode: string | null
): Promise<{ error: string } | { regionId: string | null }> {
  if (regionCode === null) return { regionId: null };
  const region = await db.region.findUnique({ where: { code: regionCode } });
  if (!region) return { error: "Region not found" };
  return { regionId: region.id };
}

function revalidateUserPaths(userId: string) {
  revalidateUserList();
  revalidateUser(userId);
}

/**
 * Creates a new user, active by default. Leaving `password` empty (the
 * form's default) creates a magic-link-only account — no `passwordHash` is
 * ever written for an empty/missing password, matching how `auth.ts`'s
 * Credentials provider treats a null `passwordHash` as "this account can't
 * use the password form."
 */
export async function createUser(formData: FormData): Promise<ActionResult> {
  await requireAdmin();

  const parsed = createUserSchema.safeParse(readCreateUserForm(formData));
  if (!parsed.success) {
    return { error: flattenZodError(parsed.error) };
  }

  const resolved = await resolveRegionId(parsed.data.regionCode);
  if ("error" in resolved) return { error: resolved.error };

  const passwordHash = parsed.data.password ? await hash(parsed.data.password) : undefined;

  let created;
  try {
    created = await db.user.create({
      data: {
        email: parsed.data.email,
        name: parsed.data.name ?? null,
        phone: parsed.data.phone ?? null,
        role: parsed.data.role,
        regionId: resolved.regionId,
        passwordHash,
        active: true,
      },
    });
  } catch (error) {
    if (isUniqueConstraintError(error)) return { error: EMAIL_EXISTS_ERROR };
    throw error;
  }

  revalidateUserList();
  redirect(`/settings/users/${created.id}`);
}

/**
 * Updates a user's name/role/region and active flag. Guarded by
 * `canModifyUser` so an admin can neither lock themselves out (deactivating
 * or demoting their own account) nor strand the system with zero active
 * admins — see src/lib/validation/users.ts for the full rationale. Email and
 * password are never touched here (see `setUserPassword` for the latter).
 */
export async function updateUser(userId: string, formData: FormData): Promise<ActionResult> {
  const session = await requireAdmin();

  const idParsed = idSchema.safeParse(userId);
  if (!idParsed.success) return { error: NOT_FOUND_ERROR };

  const parsed = updateUserSchema.safeParse(readUpdateUserForm(formData));
  if (!parsed.success) {
    return { error: flattenZodError(parsed.error) };
  }

  const target = await db.user.findUnique({ where: { id: userId } });
  if (!target) return { error: NOT_FOUND_ERROR };

  const activeAdminCount = await countActiveAdmins();
  const blockedReason = canModifyUser(
    session.user.id,
    { id: target.id, role: target.role, active: target.active },
    { role: parsed.data.role, active: parsed.data.active },
    activeAdminCount
  );
  if (blockedReason) return { error: blockedReason };

  const resolved = await resolveRegionId(parsed.data.regionCode);
  if ("error" in resolved) return { error: resolved.error };

  await db.user.update({
    where: { id: userId },
    data: {
      name: parsed.data.name ?? null,
      phone: parsed.data.phone ?? null,
      role: parsed.data.role,
      regionId: resolved.regionId,
      active: parsed.data.active,
    },
  });

  revalidateUserPaths(userId);
  return {};
}

/**
 * Replaces a user's password hash outright — used both to set an initial
 * password for a magic-link-only account and to rotate an existing one.
 * Always requires a real (≥10 char) password; there's no "leave blank to
 * keep the current one" case here, unlike `updateUser`'s other fields —
 * the form only submits this action when the admin actually typed a new
 * password (see SetPasswordForm).
 */
export async function setUserPassword(userId: string, formData: FormData): Promise<ActionResult> {
  await requireAdmin();

  const idParsed = idSchema.safeParse(userId);
  if (!idParsed.success) return { error: NOT_FOUND_ERROR };

  const parsed = setUserPasswordSchema.safeParse({ password: formData.get("password") });
  if (!parsed.success) {
    return { error: flattenZodError(parsed.error) };
  }

  const target = await db.user.findUnique({ where: { id: userId } });
  if (!target) return { error: NOT_FOUND_ERROR };

  const passwordHash = await hash(parsed.data.password);
  await db.user.update({ where: { id: userId }, data: { passwordHash } });

  revalidateUserPaths(userId);
  return {};
}

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

// --- avatar ------------------------------------------------------------------

/** Same URL-shape check `updateProductImage`/`updateOptionImage` apply in
 * src/lib/actions/catalog.ts, duplicated rather than imported so this
 * module doesn't reach into catalog.ts for an unrelated helper — `url` is
 * either a `/api/files/<name>` path `saveUpload` could have produced, or
 * `null` to clear the avatar. */
function parseAvatarUrl(url: string | null): { ok: true; value: string | null } | { ok: false } {
  if (url === null) return { ok: true, value: null };
  if (!IMAGE_URL_PATTERN.test(url)) return { ok: false };
  return { ok: true, value: url };
}

/**
 * Sets (or clears, with `url: null`) a user's avatar — `User.image`,
 * NextAuth's own profile-picture column, reused here (see
 * src/lib/queries/documents.ts's `author` field for the read-side reuse
 * note) since this app's credentials/magic-link auth never populates it on
 * its own. Authorization is the one rule that matters for this action (the
 * upload route itself just stores a file — see src/app/api/uploads/
 * route.ts): an ADMIN may set anyone's avatar, a MANAGER only their own,
 * checked here via `canSetAvatar` against the *session's* user id — never
 * trusting the client to only ever submit its own id as `userId`.
 */
export async function setUserAvatar(userId: string, url: string | null): Promise<ActionResult> {
  const session = await requireSession();

  if (!canSetAvatar(session.user.id, session.user.role, userId)) {
    return { error: "You can only change your own avatar" };
  }

  const idParsed = idSchema.safeParse(userId);
  if (!idParsed.success) return { error: NOT_FOUND_ERROR };

  const parsed = parseAvatarUrl(url);
  if (!parsed.ok) return { error: "Invalid image URL" };

  const target = await db.user.findUnique({ where: { id: userId } });
  if (!target) return { error: NOT_FOUND_ERROR };

  await db.user.update({ where: { id: userId }, data: { image: parsed.value } });

  revalidateUserPaths(userId);
  // The dashboard greeting and the settings Account card both show the
  // signed-in user's own avatar — revalidate both so a self-service change
  // (the MANAGER case `canSetAvatar` allows) shows up immediately rather
  // than waiting on those pages' own `force-dynamic`/cache lifetimes.
  revalidateHome();
  revalidateSettings();
  return {};
}

// --- signature -----------------------------------------------------------

/**
 * Stores the signature drawn in Account as a PNG upload and points
 * `User.signatureUrl` at it. Unlike `setUserAvatar`, there is no `userId`
 * parameter and therefore no `canSetAvatar`-style permission check to write:
 * the only row this can ever touch is `session.user.id`, so an ADMIN cannot
 * set this on someone else's behalf the way they can an avatar — a signature
 * is the one profile field nobody may draw for another person.
 *
 * The pad hands back a data URL, not a `File`, so this calls `saveUpload`
 * directly on the server rather than going through the two-step
 * upload-then-attach flow `AvatarEditor` uses against `/api/uploads` — there
 * is no browser `<input type="file">` in this flow for that route to serve.
 * `parseSignatureDataUrl` (src/lib/signing/data-url.ts) is the trust boundary
 * that validates the string before any bytes reach `saveUpload`.
 *
 * Note this is only the *saved* signature. Applying it to a quote copies the
 * file (a later task, signQuoteAsAuthor), so changing it here never alters a
 * signature already on an issued quote — see Signature.imageUrl's doc
 * comment in schema.prisma.
 */
export async function saveMySignature(dataUrl: string): Promise<ActionResult> {
  const session = await requireSession();

  const parsed = parseSignatureDataUrl(dataUrl);
  if (!parsed.ok) return { error: "That signature could not be read. Please draw it again." };

  const file = new File([new Uint8Array(parsed.bytes)], "signature.png", { type: "image/png" });
  const url = await saveUpload(file, ["png"]);

  await db.user.update({ where: { id: session.user.id }, data: { signatureUrl: url } });
  revalidateSettings();
  return {};
}

/**
 * Clears the caller's saved signature. The upload file itself is left on
 * disk rather than deleted: it may already have been copied onto issued
 * quotes (see `saveMySignature`'s doc comment), and those copies — not this
 * column — are what those quotes render, so deleting the bytes here would
 * gain nothing and risks breaking a reference this action has no way to see.
 */
export async function clearMySignature(): Promise<ActionResult> {
  const session = await requireSession();
  await db.user.update({ where: { id: session.user.id }, data: { signatureUrl: null } });
  revalidateSettings();
  return {};
}
