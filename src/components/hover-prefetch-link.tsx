"use client";

import Link from "next/link";
import { useState, type ComponentProps } from "react";

/**
 * A `<Link>` that prefetches on hover (or focus, or touch) instead of the
 * moment it is on screen.
 *
 * The app's chrome — the nav rail, the bottom bar, the logo — is on screen
 * on every page, and every save in the quote builder revalidates the quote,
 * which empties the router's prefetch cache. Production logs showed what
 * that costs: each save was followed by about fifteen background requests
 * re-prefetching Quotes, Clients, Catalog, Documents, Settings and the
 * dashboard, none of which the salesperson was about to open. On a slow
 * connection those compete with the next save for the line.
 *
 * Deferring to intent (the pattern from Next's own prefetching guide) keeps
 * navigation quick for a link someone is actually reaching for and stops
 * the storm. Touch has no hover, so `onTouchStart` stands in for it; focus
 * covers the keyboard.
 */
export function HoverPrefetchLink({
  onMouseEnter,
  onFocus,
  onTouchStart,
  ...props
}: Omit<ComponentProps<typeof Link>, "prefetch">) {
  const [active, setActive] = useState(false);

  return (
    <Link
      {...props}
      prefetch={active ? null : false}
      onMouseEnter={(event) => {
        setActive(true);
        onMouseEnter?.(event);
      }}
      onFocus={(event) => {
        setActive(true);
        onFocus?.(event);
      }}
      onTouchStart={(event) => {
        setActive(true);
        onTouchStart?.(event);
      }}
    />
  );
}
