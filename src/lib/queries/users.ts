import { cache } from "react";
import { db } from "@/lib/db";

export type UserListItem = {
  id: string;
  email: string;
  name: string | null;
  role: "ADMIN" | "MANAGER" | "DEVELOPER";
  active: boolean;
  regionCode: string | null;
  /** True when the user has no `passwordHash` — they can only sign in via
   * the magic-link (email) flow, not the credentials form. Drives the
   * "Magic link only" indicator in the users list. */
  magicLinkOnly: boolean;
  /** `User.image` — NextAuth's own profile-picture column, reused as this
   * user's avatar (see src/lib/queries/documents.ts's `author` field for
   * the fuller reuse note) — a stored `/api/files/<name>` URL, or `null`. */
  image: string | null;
};

/**
 * Every user in the system, ordered by email — this page is ADMIN-only and
 * unscoped (unlike clients/documents, there's no per-manager ownership
 * concept for users), so there's no `ScopeUser` filter to apply here.
 */
export async function listUsers(): Promise<UserListItem[]> {
  const users = await db.user.findMany({
    orderBy: { email: "asc" },
    include: { region: true },
  });

  return users.map((u) => ({
    id: u.id,
    email: u.email,
    name: u.name,
    role: u.role,
    active: u.active,
    regionCode: u.region?.code ?? null,
    magicLinkOnly: !u.passwordHash,
    image: u.image,
  }));
}

export type UserDetail = {
  id: string;
  email: string;
  name: string | null;
  phone: string | null;
  role: "ADMIN" | "MANAGER" | "DEVELOPER";
  active: boolean;
  regionCode: string | null;
  magicLinkOnly: boolean;
  /** `User.image` — see `UserListItem.image`'s doc comment for the reuse
   * note. Feeds both the admin's user-edit avatar control and, for a
   * caller's own id, the account settings/dashboard avatar. */
  image: string | null;
  /** `User.signatureUrl` — the manager's saved signature, drawn once in
   * Account (see src/lib/actions/users.ts's `saveMySignature`). Unlike
   * `image`, this is never shown to anyone but its owner: it feeds only the
   * Account settings page, never the admin user-edit screen or the
   * dashboard greeting. */
  signatureUrl: string | null;
};

/** A single user by id, or `null` if it doesn't exist — feeds the
 * /settings/users/[userId] edit page, and (called with the signed-in user's
 * own id) any screen that needs a fresh read of their own avatar — the
 * session JWT only revalidates every few minutes (see src/auth.ts), so
 * reading straight from the database here shows an avatar change
 * immediately rather than after that window.
 *
 * Request-memoized, which doesn't weaken that freshness guarantee: the memo
 * only ever collapses reads made while rendering one page (the user editor
 * reads it in `generateMetadata` and again in the page body) into the single
 * fresh read the first of them already made. */
export const getUser = cache(async function getUser(userId: string): Promise<UserDetail | null> {
  const user = await db.user.findUnique({ where: { id: userId }, include: { region: true } });
  if (!user) return null;

  return {
    id: user.id,
    email: user.email,
    name: user.name,
    phone: user.phone,
    role: user.role,
    active: user.active,
    regionCode: user.region?.code ?? null,
    magicLinkOnly: !user.passwordHash,
    image: user.image,
    signatureUrl: user.signatureUrl,
  };
});

/** Count of currently active users with admin rights (ADMIN or DEVELOPER —
 * see `isAdminRole`) — feeds the last-active-admin safeguard in
 * `canModifyUser` (src/lib/validation/users.ts). Computed fresh on every
 * mutating action rather than cached, since it gates a safety check. */
export async function countActiveAdmins(): Promise<number> {
  return db.user.count({ where: { role: { in: ["ADMIN", "DEVELOPER"] }, active: true } });
}

export type UserFootprint = {
  /** Client companies this user owns. Ownership is what makes a company
   * visible to a manager (see `companyWhereForUser`), so these are the rows
   * that go dark for everyone but an admin when the user leaves. */
  companies: number;
  /** Quotes this user authored. Authorship is a historical fact and is never
   * reassigned — a quote says who prepared it. */
  documents: number;
  /** Support messages sent, and catalogue imports run. Neither is reassignable
   * either; both are records of something the person did. */
  supportMessages: number;
  catalogImports: number;
};

/**
 * What a user leaves behind — the four tables that still reference them once
 * their sessions are gone.
 *
 * Drives both halves of the user screen's danger zone: `companies` is what the
 * handover control offers to move, and all four together are what decide
 * whether deleting is possible at all. A user with any of them cannot be
 * deleted (`deleteUser` re-checks this itself), because three of the four
 * columns are required or restricted at the database and the fourth would
 * quietly blank a company's owner.
 */
export async function getUserFootprint(userId: string): Promise<UserFootprint> {
  const [companies, documents, supportMessages, catalogImports] = await Promise.all([
    db.company.count({ where: { ownerId: userId } }),
    db.document.count({ where: { authorId: userId } }),
    db.supportMessage.count({ where: { authorId: userId } }),
    db.catalogImport.count({ where: { userId } }),
  ]);
  return { companies, documents, supportMessages, catalogImports };
}

/**
 * Everyone a departing user's companies could be handed to: active users,
 * never the departing user themselves, ordered the way the users list is.
 * Inactive accounts are excluded — handing clients to an account that cannot
 * sign in is the same as losing them.
 */
export async function listHandoverCandidates(
  excludeUserId: string
): Promise<{ id: string; email: string; name: string | null }[]> {
  return db.user.findMany({
    where: { active: true, id: { not: excludeUserId } },
    orderBy: { email: "asc" },
    select: { id: true, email: true, name: true },
  });
}

/** Every currently active user holding the DEVELOPER role — the recipient
 * list for a PathQuote Support submission (see
 * src/lib/actions/support.ts and src/lib/support.ts's `resolveSupportRecipients`,
 * which turns this into a plain refusal when it comes back empty). Inactive
 * developers are excluded on purpose: a deactivated account shouldn't keep
 * receiving mail. */
export async function listActiveDevelopers(): Promise<{ email: string; name: string | null }[]> {
  return db.user.findMany({
    where: { role: "DEVELOPER", active: true },
    select: { email: true, name: true },
  });
}
