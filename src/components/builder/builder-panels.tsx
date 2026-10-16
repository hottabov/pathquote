"use client";

import { useState, type ReactNode } from "react";
import { useSearchParams } from "next/navigation";
import { parseTab, type BuilderTab } from "@/lib/builder-tabs";

/**
 * The builder's tab panels: which one is on screen, and -- the point of this
 * component -- which ones exist in the DOM at all.
 *
 * The page renders every panel's content server-side (all the data is in hand
 * from its one `Promise.all`) and hands them here as props; this decides
 * which of them to mount. Before it existed the page rendered all three or
 * four panels into the HTML with `hidden` on the inactive ones, and every one
 * of them hydrated on load: the Quote-setup panel's `NotesSection` mounted
 * its lazy Tiptap editor (393 KB) on every DRAFT open for a tab most visits
 * never switch to, and two of the three panels' client components were paid
 * for and never seen. A panel is now mounted the first time it is selected
 * -- the active one on the initial render, the others on demand -- and the
 * HTML carries only the active one.
 *
 * MOUNTED ONCE, THEN KEPT. A panel that has been shown stays in the tree,
 * hidden with the `hidden` attribute, rather than being unmounted on the way
 * out. This is not an optimisation to undo: the panels hold in-progress
 * state that unmounting would lose -- `useAutosave`'s cleanup cancels a
 * pending save without running it (src/lib/use-autosave.ts), so a note typed
 * and followed within 800 ms by a tab switch would silently vanish, and an
 * open "+ New company" form would be wiped. It also means switching back
 * costs nothing: the component tree is already there.
 *
 * `visited` is state derived during render: when the active tab is not in
 * the set yet, the set is replaced with one that has it, and React re-runs
 * this render with the new state before committing (the documented way to
 * derive state from props without an effect -- an effect would commit a
 * render with the panel missing, then another with it). On the server (one
 * render) and on the client's first render the set holds exactly the active
 * tab, so hydration sees the same tree.
 *
 * The active tab comes from the same `?tab=` that `BuilderTabs` writes with
 * `history.replaceState`; Next keeps `useSearchParams` in step with native
 * history updates, so a switch is one client render and zero requests. The
 * ids and `aria-labelledby` pair with the strip's `role="tab"` buttons.
 */
export function BuilderPanels({
  tabs,
  panels,
}: {
  /** Which tabs this quote has, in order -- see `builderTabsFor`. `?tab=` is
   * resolved against this list, so a draft's `?tab=forms` lands on Build. */
  tabs: BuilderTab[];
  /** Each tab's server-rendered content. A tab in `tabs` with no entry here
   * (or a `null`) renders an empty panel. */
  panels: Partial<Record<BuilderTab, ReactNode>>;
}) {
  const params = useSearchParams();
  const active = parseTab(params.get("tab"), tabs);

  const [visited, setVisited] = useState<ReadonlySet<BuilderTab>>(() => new Set([active]));
  if (!visited.has(active)) setVisited(new Set(visited).add(active));

  return (
    <>
      {tabs.map((id) =>
        visited.has(id) ? (
          <div
            key={id}
            role="tabpanel"
            id={`builder-panel-${id}`}
            aria-labelledby={`builder-tab-${id}`}
            hidden={id !== active}
            className="flex flex-col gap-4"
          >
            {panels[id]}
          </div>
        ) : null
      )}
    </>
  );
}
