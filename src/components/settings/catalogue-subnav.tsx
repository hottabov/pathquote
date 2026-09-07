import Link from "next/link";
import { cn } from "@/lib/utils";

const TABS = [
  { href: "/settings/option-conflict-groups", label: "Option conflict groups" },
  { href: "/settings/spec-images", label: "Spec diagrams" },
] as const;

/**
 * The Catalogue nav section bundles independent list pages — option
 * conflict groups and spec diagrams — under one entry (see
 * src/lib/settings-nav.ts). This lets a user flip between them without
 * detouring back through the outer settings nav, the same "no intermediate
 * card to click through" goal the settings redesign applies one level up.
 * Rendered by each of the list pages themselves, immediately under their
 * `PageHeader` — except below `sm`, where `order-first` lifts it to the top
 * of the page instead. Under the header it sits after a title, a
 * description and (on some pages) a stacked action button, all three of
 * which differ per page and wrap to different heights on a phone — so the
 * tabs landed somewhere different on every page and appeared to jump as you
 * flipped between them. Above the header its position depends on nothing
 * but itself. Each page root is a `flex flex-col`, which is what makes the
 * reorder possible without moving it in the DOM (so focus and reading order
 * still follow the heading).
 */
export function CatalogueSubnav({ active }: { active: "option-conflict-groups" | "spec-images" }) {
  return (
    <div role="tablist" aria-label="Catalogue" className="order-first inline-flex w-fit flex-wrap gap-1 rounded-lg border border-slate-200 bg-white p-1 sm:order-none">
      {TABS.map((tab) => {
        const isActive = tab.href === `/settings/${active}`;
        return (
          <Link
            key={tab.href}
            href={tab.href}
            role="tab"
            aria-selected={isActive}
            className={cn(
              "focus-ring inline-flex min-h-9 items-center rounded-md px-3 text-sm font-medium whitespace-nowrap transition-colors",
              isActive ? "bg-brand text-white" : "text-slate-600 hover:bg-slate-100"
            )}
          >
            {tab.label}
          </Link>
        );
      })}
    </div>
  );
}
