import type { ReactNode } from "react";
import { auth } from "@/auth";
import { SettingsNav } from "@/components/settings/settings-nav";

/**
 * Wraps every /settings/* route with the section's own persistent nav (see
 * SettingsNav) so clicking a section shows it immediately, with no
 * intermediate "Settings" hub card to click through first — the point of
 * "feat: settings gets its own navigation". The viewer is passed down rather
 * than re-read by the nav itself so there's exactly one place (this layout)
 * doing the session lookup for the whole area. It is a role plus
 * `actSyncVisible` because one section (ACT! sync) is a per-user grant — see
 * `SettingsNavViewer` in src/lib/settings-nav.ts. Both come off the session,
 * so this stays one `auth()` and no query.
 *
 * AppLayout (src/app/(app)/layout.tsx) already calls requireSession and
 * redirects unauthenticated requests, so a session is always present here.
 */
export default async function SettingsLayout({ children }: { children: ReactNode }) {
  const session = (await auth())!;

  return (
    <div className="flex flex-col gap-6 lg:flex-row lg:items-start lg:gap-8">
      <SettingsNav
        viewer={{ role: session.user.role, actSyncVisible: session.user.actSyncVisible }}
      />
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}
