// The Settings area's own left-hand navigation — six sections, each shown
// immediately on click rather than behind an intermediate card (see the
// commit that introduced this file: "feat: settings gets its own
// navigation"). Kept as a plain, dependency-light data module (only
// `lucide-react` icon components and the equally pure `isAdminRole`) so the
// visibility rule below — which section a given role gets to see — is
// unit-testable without a database or a rendered component.
import type { LucideIcon } from "lucide-react";
import { User, SlidersHorizontal, Users, Package, MapPin, LifeBuoy, ArrowLeftRight } from "lucide-react";
import { isAdminRole } from "./roles";

export type SettingsNavItem = {
  href: string;
  label: string;
  icon: LucideIcon;
  /** Account and PathQuote Support are open to every signed-in user; every
   * other section is ADMIN-or-DEVELOPER only (see isAdminRole). Preferences
   * moved here from the open set: its values are business-wide defaults a
   * manager cannot change, and showing them read-only advertised settings
   * that are none of their concern. */
  adminOnly: boolean;
  /** Extra path prefixes (besides `href`) that should also mark this item
   * active. Catalogue bundles independent list pages — content blocks,
   * option conflict groups, and spec diagrams — under one nav entry (see
   * the section's own page for the in-page switcher between them), so each
   * needs to light the same nav item up. */
  activePrefixes?: string[];
};

export const SETTINGS_NAV_ITEMS: SettingsNavItem[] = [
  { href: "/settings", label: "Account", icon: User, adminOnly: false },
  { href: "/settings/preferences", label: "Preferences", icon: SlidersHorizontal, adminOnly: true },
  { href: "/settings/users", label: "Users", icon: Users, adminOnly: true },
  {
    href: "/settings/content",
    label: "Catalogue",
    icon: Package,
    adminOnly: true,
    activePrefixes: ["/settings/option-conflict-groups", "/settings/spec-images"],
  },
  { href: "/settings/regions", label: "Regions", icon: MapPin, adminOnly: true },
  // The catalogue as a workbook: download, edit in Excel, upload back with a
  // preview of every change (docs/plans/2026-09-05-catalog-import-export.md).
  // Its own section rather than a Catalogue sub-page because it is a global,
  // destructive action, not another list to administer.
  { href: "/settings/import-export", label: "Import / Export", icon: ArrowLeftRight, adminOnly: true },
  // Open to every signed-in user, same as Account/Preferences — a MANAGER
  // is exactly who most needs to reach the developer about a pricing or
  // technical problem (see src/app/(app)/settings/support/page.tsx).
  { href: "/settings/support", label: "PathQuote Support", icon: LifeBuoy, adminOnly: false },
];

/**
 * The nav items a user with `role` should actually see — a MANAGER never
 * gets handed an admin-only href to begin with, rather than being routed to
 * a page that then 404s on them (see each section's own page guard for that
 * defense-in-depth check).
 */
export function visibleSettingsNavItems(role: string | null | undefined): SettingsNavItem[] {
  const admin = isAdminRole(role);
  return SETTINGS_NAV_ITEMS.filter((item) => admin || !item.adminOnly);
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
