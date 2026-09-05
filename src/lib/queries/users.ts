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
  };
});

/** Count of currently active users with admin rights (ADMIN or DEVELOPER —
 * see `isAdminRole`) — feeds the last-active-admin safeguard in
 * `canModifyUser` (src/lib/validation/users.ts). Computed fresh on every
 * mutating action rather than cached, since it gates a safety check. */
export async function countActiveAdmins(): Promise<number> {
  return db.user.count({ where: { role: { in: ["ADMIN", "DEVELOPER"] }, active: true } });
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
