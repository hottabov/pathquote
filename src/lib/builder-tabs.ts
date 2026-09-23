/**
 * The builder's tab identity, kept out of the tab strip's own module.
 *
 * `builder-tabs.tsx` is a client component (it needs `useSearchParams`), and
 * a `"use client"` module's exports cannot be *called* from a server
 * component, only rendered or passed as props. The quote page is a server
 * component and has to resolve `?tab=` before it decides which panel to mark
 * hidden, so the parser lives here where both sides can reach it.
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
