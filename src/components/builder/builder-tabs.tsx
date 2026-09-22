"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Hammer, ScrollText, History } from "lucide-react";
import { cn } from "@/lib/utils";
import { CountBadge } from "@/components/ui-kit";
import { parseTab, type BuilderTab } from "@/lib/builder-tabs";

export type { BuilderTab };

const TABS = [
  { id: "build", label: "Build", Icon: Hammer },
  { id: "terms", label: "Quote terms", Icon: ScrollText },
  { id: "history", label: "History", Icon: History },
] as const;

/**
 * The builder's three tabs, with the active one carried in the URL as `?tab=`.
 *
 * In the URL rather than in component state for two reasons the user hits
 * daily: the browser's back button then steps between tabs instead of leaving
 * the quote entirely, and a link to a particular quote's terms can be sent to
 * someone. `scroll: false` because switching tabs is not navigation to a new
 * document and should not throw the page back to the top.
 *
 * `router.replace`, not `push`: a tab is a view of the same quote, so filling
 * the history stack with one entry per glance would make back useless for its
 * real job of leaving the quote. The one back step between tabs comes from
 * replace swapping the current entry.
 *
 * The route is untouched. `/quotes/[documentId]` still renders all three
 * panels server-side; this only decides which one is visible, so switching is
 * instant and no data is refetched.
 */
export function BuilderTabs({ counts }: { counts: Partial<Record<BuilderTab, number>> }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const active = parseTab(params.get("tab"));

  function select(tab: BuilderTab) {
    const next = new URLSearchParams(params.toString());
    if (tab === "build") next.delete("tab");
    else next.set("tab", tab);
    const query = next.toString();
    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  return (
    // The hairline lives on this row and the active tab covers its own slice
    // of it with `-mb-px` plus a matching background, so the line runs along,
    // steps around the open tab and carries on. That break is the whole
    // signal that the panel below belongs to this tab.
    <div
      role="tablist"
      aria-label="Quote sections"
      className="flex gap-1 overflow-x-auto overflow-y-hidden px-4 [scrollbar-width:none] md:px-6 lg:px-8 [&::-webkit-scrollbar]:hidden"
    >
      {TABS.map(({ id, label, Icon }) => {
        const selected = id === active;
        const count = counts[id];
        return (
          <button
            key={id}
            type="button"
            role="tab"
            id={`builder-tab-${id}`}
            aria-selected={selected}
            aria-controls={`builder-panel-${id}`}
            onClick={() => select(id)}
            className={cn(
              "focus-ring -mb-px flex min-h-11 shrink-0 items-center gap-2 rounded-t-(--radius-card) border border-b-0 px-3.5 pb-2.5 text-sm whitespace-nowrap transition-colors duration-(--duration-micro) motion-reduce:transition-none",
              selected
                ? // bg-slate-50 is the page background the panel below sits
                  // on, not a token of its own: the tab has to be exactly
                  // that colour for the two to read as one surface.
                  "border-line bg-slate-50 font-semibold text-brand"
                : "border-transparent font-medium text-slate-500 md:hover:bg-slate-50/70 md:hover:text-brand-dark"
            )}
          >
            <Icon className="size-4" aria-hidden="true" />
            {label}
            {count ? <CountBadge tone={selected ? "brand" : "neutral"}>{count}</CountBadge> : null}
          </button>
        );
      })}
    </div>
  );
}
