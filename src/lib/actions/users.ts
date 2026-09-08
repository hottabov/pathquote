"use server";

import {
  revalidateCompanyList,
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
import { countActiveAdmins, getUserFootprint, type UserFootprint } from "@/lib/queries/users";
import { IMAGE_URL_PATTERN, saveUpload, UploadValidationError } from "@/lib/uploads";
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
 * Updates a user's name, phone, role and region. Guarded by `canModifyUser` so
 * an admin can't demote their own account or the last remaining one — see
 * src/lib/validation/users.ts for the full rationale.
 *
 * Access (`active`) is NOT here: it has its own action and its own button (see
 * `setUserActive`), so revoking someone's sign-in can't happen as a side effect
 * of correcting their phone number. Email and password aren't here either (see
 * `setUserPassword` for the latter).
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
    { role: parsed.data.role },
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
    },
  });

  revalidateUserPaths(userId);
  return {};
}

/**
 * Turns one user's access on or off, as a single deliberate act.
 *
 * Deactivating is the answer to "a manager left" — it is the only thing this
 * app does about a departure, and it is enough: `src/auth.ts` refuses an
 * inactive account at sign-in and drops its existing sessions on the next JWT
 * refresh, while every quote they wrote and every client they owned stays
 * exactly where it is. Nothing is deleted, because a quote a customer signed
 * names its author, and the row that name comes from has to still be there.
 *
 * This used to be a checkbox inside `updateUser`'s details form — two rows
 * above "Save changes", indistinguishable from editing a phone number, and
 * silently equivalent to "revoke" for any caller that stopped sending the
 * field (an absent checkbox and an unticked one submit the same nothing). It
 * is now its own action behind its own button, and `updateUserSchema` has no
 * `active` field at all. Same `canModifyUser` guard: no self-lockout, never the
 * last active admin.
 *
 * The companies of a manager being deactivated are worth handing over first —
 * see `reassignUserCompanies`. Deactivating without doing so is allowed (an
 * admin still sees everything, and the clients can be handed over afterwards),
 * so this does not block on it; the screen warns instead.
 */
export async function setUserActive(userId: string, active: boolean): Promise<ActionResult> {
  const session = await requireAdmin();

  const idParsed = idSchema.safeParse(userId);
  if (!idParsed.success) return { error: NOT_FOUND_ERROR };

  const target = await db.user.findUnique({ where: { id: userId } });
  if (!target) return { error: NOT_FOUND_ERROR };

  const activeAdminCount = await countActiveAdmins();
  const blockedReason = canModifyUser(
    session.user.id,
    { id: target.id, role: target.role, active: target.active },
    { active },
    activeAdminCount
  );
  if (blockedReason) return { error: blockedReason };

  await db.user.update({ where: { id: userId }, data: { active } });

  revalidateUserPaths(userId);
  return {};
}

/**
 * Hands every client company owned by `fromUserId` to `toUserId`.
 *
 * The problem this solves: a company is visible to a manager only if they own
 * it (`companyWhereForUser`). When a manager leaves, their clients stay owned
 * by an account nobody signs into, which means no other manager can see them at
 * all — the clients effectively vanish, while looking perfectly fine to the
 * admin who checks.
 *
 * Companies move; quotes do not. Ownership of a client is a live fact about who
 * looks after them, and it is meant to change hands. Authorship of a quote is a
 * record of who wrote it — it is printed on the document and, once signed, is
 * part of what the customer agreed to. Rewriting that to tidy up a leaver's
 * account would be falsifying the paperwork, so a departed author's quotes stay
 * theirs and stay visible to admins.
 *
 * Idempotent and safe to run on a user with no companies: it moves whatever is
 * there and reports how many.
 */
export async function reassignUserCompanies(
  fromUserId: string,
  toUserId: string
): Promise<ActionResult & { moved?: number }> {
  await requireAdmin();

  const fromParsed = idSchema.safeParse(fromUserId);
  const toParsed = idSchema.safeParse(toUserId);
  if (!fromParsed.success || !toParsed.success) return { error: NOT_FOUND_ERROR };

  if (fromParsed.data === toParsed.data) {
    return { error: "Pick a different user to hand the clients to." };
  }

  const [from, to] = await Promise.all([
    db.user.findUnique({ where: { id: fromParsed.data } }),
    db.user.findUnique({ where: { id: toParsed.data } }),
  ]);
  if (!from || !to) return { error: NOT_FOUND_ERROR };

  // Handing clients to an account that can't sign in is the same as leaving
  // them with the departing one. The screen only offers active users; this is
  // the check.
  if (!to.active) {
    return { error: "That account is deactivated — pick someone who can sign in." };
  }

  const { count } = await db.company.updateMany({
    where: { ownerId: from.id },
    data: { ownerId: to.id },
  });

  revalidateCompanyList();
  revalidateUserPaths(fromUserId);
  revalidateUser(toUserId);
  return { moved: count };
}

/**
 * Deletes a user who left nothing behind.
 *
 * Deleting is deliberately the narrow case, not the general answer to someone
 * leaving — that is `setUserActive`. It exists for the account created with a
 * typo in the address, or the person who never signed in: a row whose removal
 * costs nothing because nothing points at it.
 *
 * Refused the moment anything does. Three of the four references
 * (`Document.author`, `SupportMessage.author`, `CatalogImport.user`) are
 * required columns the database would refuse to orphan anyway, so without this
 * check the admin would meet a raw constraint error instead of a sentence. The
 * fourth (`Company.owner`) is nullable and would go through — silently blanking
 * the owner of every client that user had, which is the outcome
 * `reassignUserCompanies` exists to prevent. So the footprint is re-read here
 * and the delete refused with what to do instead.
 *
 * Sessions, accounts and catalogue-visibility rows cascade (see the schema) —
 * those are per-login state, not records of anything the person did.
 */
export async function deleteUser(userId: string): Promise<ActionResult> {
  const session = await requireAdmin();

  const idParsed = idSchema.safeParse(userId);
  if (!idParsed.success) return { error: NOT_FOUND_ERROR };

  const target = await db.user.findUnique({ where: { id: userId } });
  if (!target) return { error: NOT_FOUND_ERROR };

  // Deleting yourself is deactivating yourself and then some, and
  // `canModifyUser` already refuses that. Reusing it keeps both rules in one
  // place: no self-lockout, and never the last active admin.
  const activeAdminCount = await countActiveAdmins();
  const blockedReason = canModifyUser(
    session.user.id,
    { id: target.id, role: target.role, active: target.active },
    { active: false },
    activeAdminCount
  );
  if (blockedReason) return { error: blockedReason };

  const footprint = await getUserFootprint(userId);
  const blocking = describeUserFootprint(footprint);
  if (blocking) {
    return {
      error: `This account can't be deleted — it still has ${blocking}. Deactivate it instead, and hand over its clients.`,
    };
  }

  await db.user.delete({ where: { id: userId } });

  revalidateUserList();
  redirect("/settings/users");
}

/** "3 clients, 12 quotes" — the parts of a footprint that are not zero, or
 * `null` when it is empty and the user can be deleted. Written out rather than
 * a bare count so the refusal names what is actually in the way. */
function describeUserFootprint(footprint: UserFootprint): string | null {
  const parts: string[] = [];
  const push = (count: number, one: string, many: string) => {
    if (count > 0) parts.push(`${count} ${count === 1 ? one : many}`);
  };
  push(footprint.companies, "client", "clients");
  push(footprint.documents, "quote", "quotes");
  push(footprint.supportMessages, "support message", "support messages");
  push(footprint.catalogImports, "catalogue import", "catalogue imports");
  if (parts.length === 0) return null;
  return parts.join(", ");
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
 *
 * Every redraw orphans the previous upload the same way `clearMySignature`
 * orphans it on removal, and for the same reason (see that action's doc
 * comment) — this mirrors `setUserAvatar`'s existing behaviour, which is
 * likewise never garbage-collected.
 */
export async function saveMySignature(dataUrl: string): Promise<ActionResult & { url?: string }> {
  const session = await requireSession();

  const parsed = parseSignatureDataUrl(dataUrl);
  if (!parsed.ok) return { error: "That signature could not be read. Please draw it again." };

  const file = new File([new Uint8Array(parsed.bytes)], "signature.png", { type: "image/png" });

  // saveUpload returns just the filename (its own doc comment says so) —
  // every other caller builds the `/api/files/<name>` URL itself (see
  // src/app/api/uploads/route.ts), and this one must too, or the stored
  // value resolves relative to whatever page renders it. Named `filename`
  // rather than `url` so that contract can't be missed again at this call
  // site. `parseSignatureDataUrl`'s magic-byte check and saveUpload's own
  // `sniffImageType` can disagree on malformed input (see that module's doc
  // comment), so this — unlike the rest of this action, which has no reason
  // to fail past validation — is wrapped the same way
  // src/app/api/uploads/route.ts wraps its own call.
  let filename: string;
  try {
    filename = await saveUpload(file, ["png"]);
  } catch (error) {
    if (error instanceof UploadValidationError) return { error: error.message };
    throw error;
  }
  const url = `/api/files/${filename}`;

  await db.user.update({ where: { id: session.user.id }, data: { signatureUrl: url } });
  revalidateSettings();
  return { url };
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
