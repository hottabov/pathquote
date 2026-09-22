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
      // No overflow of any kind here. The open tab covers the header's
      // hairline with a ::after that sits one pixel BELOW its own box, so
      // any overflow other than visible clips exactly the pixel the whole
      // effect depends on. The three tabs fit inside a 390px phone with
      // room to spare, so there was nothing to scroll for anyway.
      className="flex gap-1 px-4 md:px-6 lg:px-8"
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
              // h-10 with items-center rather than min-h-11 plus a bottom
              // padding: that pair left more room above the label than below
              // it, and made a strip of secondary navigation as tall as a
              // primary control. 40px still clears a fingertip.
              "focus-ring relative flex h-10 shrink-0 items-center gap-2 rounded-t-(--radius-control) border border-b-0 px-3.5 text-sm whitespace-nowrap transition-colors duration-(--duration-micro) motion-reduce:transition-none",
              selected
                ? // Two things at once. bg-slate-50 is the page background the
                  // panel below sits on, not a token of its own: the open tab
                  // has to be exactly that colour for the two to read as one
                  // surface. The ::after then paints a 1px strip of the same
                  // colour over the header's own full-width hairline, which
                  // is what makes the line run along, step around this tab
                  // and carry on. Doing it with a pseudo-element rather than
                  // -mb-px because the line lives two elements up, on the
                  // only box that is full bleed, and a negative margin here
                  // cannot reach it.
                  "border-line bg-slate-50 font-semibold text-brand after:absolute after:inset-x-0 after:-bottom-px after:h-px after:bg-slate-50 after:content-['']"
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
