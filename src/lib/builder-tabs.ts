/**
 * The builder's tab identity, kept out of the tab strip's own module.
 *
 * `builder-tabs.tsx` is a client component (it needs `useSearchParams`), and
 * a `"use client"` module's exports cannot be *called* from a server
 * component, only rendered or passed as props. The quote page is a server
 * component and decides which tabs a quote has (`builderTabsFor`) from its
 * status; the strip and the panel host (`builder-panels.tsx`) are both client
 * components that resolve `?tab=` against that list with `parseTab`. Pure
 * functions here, so the two sides agree by construction and the parsing is
 * unit-tested without a browser or a database.
 */
export type BuilderTab = "build" | "settings" | "forms" | "history";

/**
 * Which tabs a quote in this state actually has.
 *
 * "forms" exists only once the quote is FINAL, because that is when the
 * order forms exist: `ProductionFormsSection` renders nothing for a draft
 * and the route behind it refuses one. A quote's job changes at
 * finalisation -- up to that point it is being built, after it it is being
 * ordered -- so the strip changing with it is the honest thing rather than
 * a surprise.
 */
export function builderTabsFor({ isFinal }: { isFinal: boolean }): BuilderTab[] {
  return isFinal
    ? ["build", "settings", "forms", "history"]
    : ["build", "settings", "history"];
}

/**
 * Anything that is not a tab this quote has is Build, including nothing at
 * all: a hand-edited or stale URL should land somewhere sensible, not 500 --
 * and `?tab=forms` on a draft is exactly such a URL, left over from before
 * an Unfinalize or pasted from a colleague's finalised copy.
 *
 * `available` defaults to every tab so the tab strip, which only ever
 * renders tabs the page gave it, can call this without repeating the state.
 */
export function parseTab(
  value: string | string[] | undefined | null,
  available: readonly BuilderTab[] = ["build", "settings", "forms", "history"]
): BuilderTab {
  const first = Array.isArray(value) ? value[0] : value;
  // `?tab=terms` was this tab's id until the card it opens stopped being
  // about terms. Honoured rather than dropped: someone's bookmark should
  // not quietly land them on Build.
  const raw = first === "terms" ? "settings" : first;
  return available.some((tab) => tab !== "build" && tab === raw) ? (raw as BuilderTab) : "build";
}

/**
 * The query string that puts `tab` in the URL, keeping every other parameter
 * as it was. Build is the default view, so selecting it removes `?tab=`
 * rather than writing `?tab=build`: the plain quote URL and "Build" are the
 * same place, and a bookmark of one should equal a bookmark of the other.
 * Returns "" when nothing is left, so the caller can append it to the
 * pathname directly.
 *
 * Pure so the tab strip's one piece of URL logic is tested here rather than
 * through `window.history`.
 */
export function builderTabSearch(currentSearch: string, tab: BuilderTab): string {
  const next = new URLSearchParams(currentSearch);
  if (tab === "build") next.delete("tab");
  else next.set("tab", tab);
  const query = next.toString();
  return query ? `?${query}` : "";
}
