"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { NAV_ITEMS } from "@/lib/nav-items";
import { cn } from "@/lib/utils";

function isActive(pathname: string, href: string) {
  return pathname === href || pathname.startsWith(`${href}/`);
}

type AppNavProps = {
  variant: "sidebar" | "bottom";
};

/**
 * Client component so it can read the current path (via usePathname) to
 * highlight the active nav item. Rendered twice by AppShell:
 *
 * - "sidebar": the persistent brand-dark rail — icons + labels at lg+,
 *   icons-only (label via `title` tooltip) at md. Active item gets an
 *   accent left bar plus a lighter background.
 * - "bottom": the fixed mobile bottom bar (<md) — active item's icon/label
 *   switch to the accent color.
 */
export function AppNav({ variant }: AppNavProps) {
  const pathname = usePathname();

  if (variant === "sidebar") {
    return (
      <nav aria-label="Main" className="flex flex-col gap-1 px-2 lg:px-3">
        {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
          const active = isActive(pathname, href);
          return (
            <Link
              key={label}
              href={href}
              title={label}
              aria-current={active ? "page" : undefined}
              className={cn(
                "focus-ring-dark group relative flex min-h-11 items-center justify-center gap-3 rounded-lg border-l-4 border-transparent px-2 text-sm font-medium text-white/70 transition-colors hover:bg-white/10 hover:text-white lg:justify-start lg:px-3",
                active && "border-brand-accent bg-white/10 text-white"
              )}
            >
              <Icon className="size-5 shrink-0" aria-hidden="true" />
              <span className="hidden truncate lg:inline">{label}</span>
            </Link>
          );
        })}
      </nav>
    );
  }

  return (
    // One column per `NAV_ITEMS` entry — five since Documents joined them.
    // A fixed `grid-cols-4` wrapped the fifth onto a second row, doubling the
    // height of a bar the page's bottom padding is sized against; five is
    // also the ceiling for a bottom bar, so a sixth entry needs a different
    // shape here rather than another column.
    <nav aria-label="Main" className="grid grid-cols-5">
      {NAV_ITEMS.map(({ href, label, icon: Icon }) => {
        const active = isActive(pathname, href);
        return (
          <Link
            key={label}
            href={href}
            aria-current={active ? "page" : undefined}
            className="focus-ring flex min-h-14 flex-col items-center justify-center gap-1 py-2 text-xs text-brand-dark transition-colors active:bg-slate-100"
          >
            <Icon className={cn("size-5", active ? "text-brand-accent-ink" : "text-brand")} aria-hidden="true" />
            <span className={cn(active && "font-semibold text-brand-accent-ink")}>{label}</span>
          </Link>
        );
      })}
    </nav>
  );
}
