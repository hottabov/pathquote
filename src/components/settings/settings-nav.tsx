"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  activeSettingsNavHref,
  visibleSettingsNavItems,
  type SettingsNavViewer,
} from "@/lib/settings-nav";
import { cn } from "@/lib/utils";

/**
 * The Settings area's own sub-navigation — a persistent list at `lg`+ (this
 * app's forms already switch to two columns at the same breakpoint — see
 * e.g. EditUserForm — so the settings layout follows suit rather than
 * introducing a second one), collapsing to a horizontally-scrollable pill
 * row below it. Below `lg`, a second vertical sidebar next to the app's own
 * would squeeze the content column into an unusable sliver on a phone —
 * this app's primary device — so the mobile shape instead mirrors the
 * `role="tablist"` filter-chip row already used on /catalog/options, not
 * AppNav's own bottom bar (that one is reserved for top-level app sections).
 *
 * Client component so it can read the current path (usePathname) to
 * highlight the active section — same reasoning as AppNav.
 *
 * Takes the whole viewer rather than a role: ACT! sync is a per-user grant now
 * (see `SettingsNavViewer`). Both fields come from the session, read once by
 * the layout — nothing here is a permission check, only which rows to draw.
 */
export function SettingsNav({ viewer }: { viewer: SettingsNavViewer }) {
  const pathname = usePathname();
  const items = visibleSettingsNavItems(viewer);
  // Resolved once for the whole nav rather than per item: which item wins is
  // a property of the item *set* (most specific prefix), not of any one of
  // them on its own -- see activeSettingsNavHref.
  const activeHref = activeSettingsNavHref(pathname, items);

  return (
    <nav aria-label="Settings sections" className="lg:w-56 lg:shrink-0">
      {/* Below lg: horizontally-scrollable pill row. */}
      <div role="tablist" aria-label="Settings sections" className="flex gap-2 overflow-x-auto pb-1 lg:hidden">
        {items.map((item) => {
          const active = item.href === activeHref;
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              role="tab"
              aria-selected={active}
              aria-current={active ? "page" : undefined}
              className={cn(
                "focus-ring inline-flex min-h-11 shrink-0 items-center gap-1.5 rounded-full border px-3.5 text-sm font-medium whitespace-nowrap transition-colors",
                active
                  ? "border-transparent bg-brand text-white"
                  : "border-slate-200 bg-white text-slate-600 hover:bg-slate-50"
              )}
            >
              <Icon className="size-4 shrink-0" aria-hidden="true" />
              {item.label}
            </Link>
          );
        })}
      </div>

      {/* lg+: persistent vertical list. */}
      <div className="hidden flex-col gap-1 lg:flex">
        {items.map((item) => {
          const active = item.href === activeHref;
          const Icon = item.icon;
          return (
            <Link
              key={item.href}
              href={item.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "focus-ring flex min-h-11 items-center gap-3 rounded-lg border-l-4 border-transparent px-3 text-sm font-medium text-slate-600 transition-colors hover:bg-slate-100 hover:text-brand-dark",
                active && "border-brand bg-brand/10 text-brand-dark"
              )}
            >
              <Icon className="size-4 shrink-0" aria-hidden="true" />
              {item.label}
            </Link>
          );
        })}
      </div>
    </nav>
  );
}
