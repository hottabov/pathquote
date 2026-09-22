/**
 * The builder's tab identity, kept out of the tab strip's own module.
 *
 * `builder-tabs.tsx` is a client component (it needs `useSearchParams`), and
 * a `"use client"` module's exports cannot be *called* from a server
 * component, only rendered or passed as props. The quote page is a server
 * component and has to resolve `?tab=` before it decides which panel to mark
 * hidden, so the parser lives here where both sides can reach it.
 */
export type BuilderTab = "build" | "terms" | "history";

/** Anything that is not a known tab is Build, including nothing at all: a
 *  hand-edited or stale URL should land somewhere sensible, not 500. */
export function parseTab(value: string | string[] | undefined | null): BuilderTab {
  const raw = Array.isArray(value) ? value[0] : value;
  return raw === "terms" || raw === "history" ? raw : "build";
}
