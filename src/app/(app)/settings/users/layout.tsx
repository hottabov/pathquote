import type { ReactNode } from "react";
import { requireAdminPage } from "@/lib/authz";

/**
 * Admin-only segment. The guard lives here rather than in each page so a
 * new sub-route under this section inherits it instead of having to
 * remember its own check. The per-page `notFound()` checks stay as defence
 * in depth — this layout is the thing that makes a *forgotten* one safe.
 *
 * `requireAdminPage`, not `requireAdmin`: a manager must get the 404 page,
 * not an error boundary reading "Forbidden", which would confirm the route
 * exists. See the two functions' comments in src/lib/authz.ts.
 */
export default async function SettingsUsersLayout({ children }: { children: ReactNode }) {
  await requireAdminPage();
  return <>{children}</>;
}
