// The Settings area's own left-hand navigation — one section per row, each shown
// immediately on click rather than behind an intermediate card (see the
// commit that introduced this file: "feat: settings gets its own
// navigation"). Kept as a plain, dependency-light data module (only
// `lucide-react` icon components and the equally pure `isAdminRole` and
// `canSeeActSync`) so the visibility rule below — which section a given viewer
// gets to see — is unit-testable without a database or a rendered component.
import type { LucideIcon } from "lucide-react";
import {
  User,
  SlidersHorizontal,
  Users,
  Package,
  MapPin,
  Factory,
  LifeBuoy,
  ArrowLeftRight,
  RefreshCw,
} from "lucide-react";
import { canSeeActSync, isAdminRole } from "./roles";

/**
 * Who the nav is being drawn for. More than a role since ACT! sync became a
 * per-user grant: `actSyncVisible` is `User.actSyncVisible`, which reaches a
 * request through the session (see src/auth.ts and `visibleCountries`, the
 * app's other per-user grant, which travels the same way).
 *
 * One required object parameter rather than `(role, actSyncVisible?)`, and the
 * optionality is the whole reason. A second optional argument makes forgetting
 * it compile, and forgetting it here silently decides a permission for every
 * caller that did — the one failure mode this shape has to refuse. An object
 * also means the next per-user section adds a field and the compiler then
 * names every call site that has to supply it.
 */
export type SettingsNavViewer = {
  role: string | null | undefined;
  /** `User.actSyncVisible` — see `canSeeActSync` in ./roles. */
  actSyncVisible: boolean;
};

export type SettingsNavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Account and PathQuote Support are open to every signed-in user; ACT! sync
   * is open to a signed-in user an admin has granted it to (see `visibleTo`
   * below and the entry's own comment); every other section is
   * ADMIN-or-DEVELOPER only (see isAdminRole).
   *
   * Preferences went the other way -- out of the open set and into the admin
   * one -- and the contrast with ACT! sync is what the rule actually is, so
   * both are worth having written down. Preferences holds business-wide
   * defaults a manager cannot change, so showing them read-only advertised
   * settings that were none of their concern. ACT! sync holds no settings at
   * all: it reports the state of a job and offers one button, and both are
   * things a manager acts on -- which is why it is not admin-only, and why
   * who exactly gets it is then a per-user question rather than a role one. */
  adminOnly: boolean;
  /** For a section that is not `adminOnly` but is still not open to everyone:
   * the predicate deciding whether this viewer gets it. Absent means open to
   * every signed-in user, which is what Account and PathQuote Support are.
   *
   * A function rather than, say, the name of a `User` column, so the nav and
   * the section's own guards share one decision instead of two copies of it:
   * ACT! sync below holds `canSeeActSync`, and that is the same function
   * `requireActSyncPage` and `requireActSync` call (src/lib/authz.ts). The nav
   * therefore cannot offer a section the page then refuses, or hide one the
   * page would have allowed. Still pure, so this module stays testable with
   * no database and no rendered component. */
  visibleTo?: (viewer: SettingsNavViewer) => boolean;
  /** Extra path prefixes (besides `href`) that should also mark this item
   * active. Catalogue bundles independent list pages — option conflict
   * groups and spec diagrams — under one nav entry (see the section's own
   * page for the in-page switcher between them), so each needs to light the
   * same nav item up. */
  activePrefixes?: string[];
};

export const SETTINGS_NAV_ITEMS: SettingsNavItem[] = [
  { href: "/settings", label: "Account", icon: User, adminOnly: false },
  { href: "/settings/preferences", label: "Preferences", icon: SlidersHorizontal, adminOnly: true },
  { href: "/settings/users", label: "Users", icon: Users, adminOnly: true },
  // Catalogue's landing page was /settings/content until
  // z37_drop_content_block deleted that route with the ContentBlock table:
  // the section's first surviving tab is now its href, so the entry points
  // at a page that exists rather than 404ing everyone who clicks it.
  {
    href: "/settings/option-conflict-groups",
    label: "Catalogue",
    icon: Package,
    adminOnly: true,
    activePrefixes: ["/settings/spec-images"],
  },
  { href: "/settings/regions", label: "Regions", icon: MapPin, adminOnly: true },
  // The shared industry list. Its own section rather than a Catalogue tab:
  // industries describe clients, not equipment, and the only other place they
  // can be touched is the typeahead on a single client's card.
  { href: "/settings/industries", label: "Industries", icon: Factory, adminOnly: true },
  // The catalogue as a workbook: download, edit in Excel, upload back with a
  // preview of every change (docs/reference/catalog-import-export.md).
  // Its own section rather than a Catalogue sub-page because it is a global,
  // destructive action, not another list to administer.
  { href: "/settings/import-export", label: "Import / Export", icon: ArrowLeftRight, adminOnly: true },
  // The nightly ACT! pull: when it last ran, what it did, and a button for
  // when somebody cannot wait for tonight. Its own section rather than a tab
  // on another one because it is operational, not a list to curate — there is
  // nothing here to edit, add or retire. The sections around it hand you rows
  // to look after; this one reports on a job that runs on its own at 03:00
  // and gives you one way to interrupt it.
  //
  // Not admin-only, but not open to everyone either: a non-admin gets this
  // section when an admin has ticked it for them (`canSeeActSync`,
  // src/lib/roles.ts, reading `User.actSyncVisible`). What a granted user gets
  // includes pressing Sync now rather than only reading the page. Pressing it
  // is harmless: the sync is read-only against ACT!, what it writes into
  // PathQuote fills blanks and never overwrites (`fillOnlyEmpty`,
  // src/lib/act/merge.ts), the session advisory lock means a second press
  // cannot start a second run, and a delta is seconds. The value is exactly
  // what an admin-only section was costing -- a manager who can see that an
  // edit they made in ACT! has not reached PathQuote can fix it themselves
  // instead of waiting for the developer to be asked.
  //
  // Per user rather than per role because the two kinds of non-admin who will
  // hold MANAGER want opposite things. The company's own managers use ACT!
  // daily and this page answers a question they really ask. A distributor --
  // an outside reseller, no ACT! licence, no ACT! access at all -- has their
  // contacts pushed into ACT! when they finalise a quote and can never look at
  // it; for them this page reports on a system they have never seen. No role
  // tells those two apart, so an admin does, one user at a time.
  {
    href: "/settings/act-sync",
    label: "ACT! sync",
    icon: RefreshCw,
    adminOnly: false,
    visibleTo: canSeeActSync,
  },
  // Open to every signed-in user, same as Account above (it said
  // "Account/Preferences" until Preferences moved into the admin set, and
  // named ACT! sync too until that became a per-user grant) — a MANAGER is
  // exactly who most needs to reach the developer about a pricing or technical
  // problem (see src/app/(app)/settings/support/page.tsx).
  { href: "/settings/support", label: "PathQuote Support", icon: LifeBuoy, adminOnly: false },
];

/**
 * The nav items `viewer` should actually see — a MANAGER never gets handed an
 * href they may not have to begin with, rather than being routed to a page
 * that then 404s on them (see each section's own page guard for that
 * defense-in-depth check).
 *
 * Two gates: `adminOnly` is the role question, and `visibleTo` is the per-user
 * one for a section that has it. Both must pass, which is not the same as "an
 * admin sees everything" being written here — it is `canSeeActSync` that lets
 * an admin through its own gate, deliberately, so that an admin cannot be
 * locked out of the section whose grant they administer. A future `visibleTo`
 * that should behave that way has to say so itself.
 *
 * Hiding a row is never the security boundary here — it is the ACT! sync page's own
 * `requireActSyncPage` and the Sync now action's `requireActSync` that refuse
 * a request, because an href is not a lock and anybody can type a URL. What
 * this function buys is that nobody is shown a door that will not open.
 */
export function visibleSettingsNavItems(viewer: SettingsNavViewer): SettingsNavItem[] {
  const admin = isAdminRole(viewer.role);
  return SETTINGS_NAV_ITEMS.filter((item) => {
    if (item.adminOnly) return admin;
    return item.visibleTo === undefined || item.visibleTo(viewer);
  });
}

/**
 * Length of the longest prefix on `item` that `pathname` sits under, or `-1`
 * when none of them do. A prefix matches the path itself or anything below
 * it (`/settings/users` also covers `/settings/users/<id>`), but only at a
 * segment boundary — otherwise `/settings/user-groups` would look like a
 * child of `/settings/users`.
 */
function navMatchLength(pathname: string, item: SettingsNavItem): number {
  const prefixes = [item.href, ...(item.activePrefixes ?? [])];
  let longest = -1;
  for (const prefix of prefixes) {
    if (pathname === prefix || pathname.startsWith(`${prefix}/`)) {
      longest = Math.max(longest, prefix.length);
    }
  }
  return longest;
}

/**
 * The `href` of the single nav item that should read as active for
 * `pathname`, or `null` when the path is outside Settings entirely.
 *
 * Most specific prefix wins, and that tie-break is the whole point: Account
 * lives at `/settings`, the area root, so a plain "is this path under my
 * href" test lights Account up on *every* settings page — the bug this
 * replaced. Comparing match lengths lets `/settings/preferences` beat
 * `/settings` without special-casing the root, and keeps working for a
 * section's own nested routes (`/settings/users/<id>` stays on Users) and
 * for `activePrefixes` (`/settings/option-conflict-groups` stays on
 * Catalogue).
 *
 * Ties are impossible: two items would have to share an identical prefix,
 * which would make them the same section.
 */
export function activeSettingsNavHref(
  pathname: string,
  items: SettingsNavItem[] = SETTINGS_NAV_ITEMS
): string | null {
  let activeHref: string | null = null;
  let longest = -1;
  for (const item of items) {
    const length = navMatchLength(pathname, item);
    if (length > longest) {
      longest = length;
      activeHref = item.href;
    }
  }
  return activeHref;
}
