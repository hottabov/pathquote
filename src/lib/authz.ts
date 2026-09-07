import { cache } from "react";
import type { Session } from "next-auth";
import { auth } from "@/auth";
import { notFound, redirect } from "next/navigation";
import { db } from "@/lib/db";
import { isAdminRole } from "@/lib/roles";
import { priceRegionIdForUser } from "@/lib/scope";

/**
 * Require an authenticated session for a server component/action. Redirects
 * to /login when there is none. The proxy in front of this app already
 * guarantees an authenticated request reaches app routes, but this is the
 * defense-in-depth check for server actions and any route the proxy doesn't
 * cover (e.g. a revoked token that hasn't hit the proxy's revalidation
 * window yet).
 */
export async function requireSession(): Promise<Session & { user: NonNullable<Session["user"]> }> {
  const session = await auth();
  if (!session?.user) {
    redirect("/login");
  }
  return session as Session & { user: NonNullable<Session["user"]> };
}

/**
 * Require an authenticated ADMIN (or DEVELOPER — see isAdminRole) session,
 * for a SERVER ACTION. Managers may view the catalog but only admins may
 * mutate it — call this at the top of every catalog server action.
 *
 * Throws, which is right for an action: the caller is a form post, and the
 * failure belongs in the action's own error handling, not in a 404 page.
 * For a page or a layout use `requireAdminPage` below instead — see its
 * comment for why the two cannot be the same function.
 */
export async function requireAdmin(): Promise<Session & { user: NonNullable<Session["user"]> }> {
  const session = await requireSession();
  if (!isAdminRole(session.user.role)) {
    throw new Error("Forbidden: admin only");
  }
  return session;
}

/**
 * Require an ADMIN (or DEVELOPER) session for a PAGE or LAYOUT, rendering
 * the 404 page for anyone else.
 *
 * Separate from `requireAdmin` because the two failures must look different
 * to the browser. This app's rule is not-found over forbidden: a route a
 * manager may not have must be indistinguishable from one that does not
 * exist, because an error boundary saying "Forbidden" confirms the route is
 * real and turns URL guessing into a map of the admin surface. `notFound()`
 * gives nothing away. A server action has no such concern — nobody
 * enumerates routes by POSTing to them — and rendering a 404 in place of an
 * action result would break the caller, hence two functions.
 *
 * Call this from the `layout.tsx` of an admin-only segment, not from each
 * page: a new sub-route then inherits the guard instead of having to
 * remember its own check. The per-page `notFound()` checks that predate
 * this stay as defence in depth.
 */
export async function requireAdminPage(): Promise<Session & { user: NonNullable<Session["user"]> }> {
  const session = await requireSession();
  if (!isAdminRole(session.user.role)) {
    notFound();
  }
  return session;
}

/**
 * Whether a region id still names a region a manager can actually work in:
 * the row exists and is still `active`. A deleted or deactivated region is
 * indistinguishable from no region for this purpose — see `requireRegion`.
 *
 * `cache()`d on the id, the same house pattern `listActiveRegions` uses
 * (src/lib/queries/catalog.ts), because a layout's guard and a server
 * action's guard both run inside one request and would otherwise each pay
 * for the round trip. Only ever called for a non-admin with a region id in
 * hand, so an admin's path adds no query at all.
 */
const isRegionUsable = cache(async function isRegionUsable(regionId: string): Promise<boolean> {
  const region = await db.region.findUnique({
    where: { id: regionId },
    select: { active: true },
  });
  return region?.active === true;
});

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
 * A manager whose assigned region has since been deactivated (or deleted)
 * lands there too, and that is the whole reason this reads the database. A
 * non-null `regionId` alone is not the same question: every screen that
 * offers regions builds its list from `listActiveRegions()`, so such a
 * manager would be offered NOTHING while their session still carried a real
 * id — the builder's inline company panel would then submit a region it
 * never displayed (the server accepts it: the row exists, it is merely
 * inactive) and file the company into a dead region, and the client card's
 * controlled select would match no option and drop `regionCode` from the
 * FormData entirely, failing with a raw Zod message. Treating "inactive"
 * as "no region" collapses both into the one state the app already handles.
 *
 * Call this from the `layout.tsx` of an area that needs a region, not from
 * each page: a new page under that area then inherits the guard instead of
 * having to remember it. Call it AGAIN from any server action that creates
 * or moves a region-bound row — a layout does not run before a server
 * action executes, so an action posted from anywhere is unguarded no matter
 * which segment its form happens to sit in. `createDraft`
 * (src/lib/actions/documents/lifecycle.ts) is the worked example.
 */
export async function requireRegion(): Promise<{
  session: Session & { user: NonNullable<Session["user"]> };
  regionId: string | null;
}> {
  const session = await requireSession();
  // Before any region lookup, and it must stay that way: an admin has no
  // region to check, and their pages would pay for a query that could only
  // ever answer a question nobody asked.
  if (isAdminRole(session.user.role)) {
    return { session, regionId: null };
  }
  const regionId = session.user.regionId;
  if (!regionId) {
    redirect("/no-region");
  }
  if (!(await isRegionUsable(regionId))) {
    redirect("/no-region");
  }
  return { session, regionId };
}

/**
 * The same question `requireRegion` answers — "which region's rows may this
 * viewer see?" — but answered synchronously from a `session.user` that may
 * be missing entirely, and without redirecting.
 *
 * That combination exists for one caller shape: a route's
 * `generateMetadata`, which must resolve the region itself. A layout guard
 * (`requireRegion` in `src/app/(app)/catalog/layout.tsx`) does not reliably
 * run before `generateMetadata`, so a page that fetches region-bound data in
 * both `generateMetadata` and its body cannot lean on the layout for the
 * metadata half. Both halves of such a page should call this and pass the
 * one result to both fetches — the query is `cache()`d on its arguments, so
 * two different values would run it twice.
 *
 * Built on `priceWhereForUser`, not `regionIdForUser`, deliberately: both
 * agree that an admin sees every region (`null`), but they disagree about a
 * viewer with no region — `regionIdForUser` returns `null` there too, i.e.
 * *every* region, which is safe only because a guard redirects that user
 * first. This runs where that guarantee does not hold, and an
 * unauthenticated caller lands on exactly that branch, so it takes the
 * fail-closed half of the pair instead: a region id no row can hold, which
 * narrows to nothing rather than widening to everything. See the doc
 * comments on both helpers in `src/lib/scope.ts`.
 *
 * The `role` fallback is `MANAGER` rather than anything admin-shaped for the
 * same reason: an absent session must not be mistaken for an unscoped one.
 */
export function priceRegionIdForSessionUser(
  user: Session["user"] | null | undefined
): string | null {
  // The decision itself lives in `priceRegionIdForUser` (src/lib/scope.ts)
  // so it can be unit-tested; this is only the session-shaped adapter over
  // it. Nothing here may branch — a rule written here is a rule with no
  // test, because the no-database suite cannot import this module.
  return priceRegionIdForUser({
    id: user?.id ?? "",
    role: user?.role ?? "MANAGER",
    regionId: user?.regionId ?? null,
  });
}
