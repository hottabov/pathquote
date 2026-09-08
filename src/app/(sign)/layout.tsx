import type { Metadata } from "next";

export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

/**
 * The layout for the client-facing signing pages. Deliberately bare: no
 * navigation, no session lookup, no link back into the application. A client
 * holding a token is not a user of this app and must not be offered a door
 * into it.
 *
 * No `<html>`/`<body>` and no `@/app/globals.css` import here, unlike the
 * plan's original sketch: this app has exactly one root layout
 * (src/app/layout.tsx), which already renders both and is the sole legal
 * place to — a second `<html>` nested inside it is invalid, and every other
 * route group (see src/app/(app)/layout.tsx, which does the same) inherits
 * the stylesheet from there rather than re-importing it. Route groups only
 * get their own root layout when the app has none at the top level, which
 * this one does.
 */
export default function SignLayout({ children }: { children: React.ReactNode }) {
  return <div className="min-h-screen bg-neutral-100">{children}</div>;
}
