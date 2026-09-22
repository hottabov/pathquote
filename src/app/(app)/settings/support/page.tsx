import type { Metadata } from "next";
import { auth } from "@/auth";
import { getRegionById } from "@/lib/queries/catalog";
import { listActiveDevelopers } from "@/lib/queries/users";
import { resolveSupportRecipients } from "@/lib/support";
import { getAppVersion } from "@/lib/app-version";
import { submitSupportMessage } from "@/lib/actions/support";
import { roleLabel } from "@/lib/roles";
import { SupportMessageForm } from "@/components/settings/support-message-form";
import { PageHeader, SectionCard, StatusBadge, STATUS_TONE } from "@/components/ui-kit";

export const metadata: Metadata = { title: "PathQuote Support" };
export const dynamic = "force-dynamic";

/**
 * PathQuote Support — reachable by any signed-in user (see
 * src/lib/settings-nav.ts), unlike every admin-only section around it. The
 * only two fields the sender fills in are subject and message; the strip
 * below the header shows exactly what else gets attached automatically —
 * their role, region, and the running app version — so nothing about the
 * report is a surprise to them.
 */
export default async function SupportSettingsPage() {
  // AppLayout (src/app/(app)/layout.tsx) already calls requireSession and
  // redirects unauthenticated requests, so a session is always present here.
  const session = (await auth())!;
  const [region, developers] = await Promise.all([
    getRegionById(session.user.regionId),
    listActiveDevelopers(),
  ]);
  const recipients = resolveSupportRecipients(developers);
  const appVersion = getAppVersion();

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        title="PathQuote Support"
        description="Report a pricing problem, a bug, or anything on the platform that isn't working right — this reaches the developer directly."
      />

      {!recipients.ok ? (
        <p className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          {recipients.error}
        </p>
      ) : null}

      <SectionCard title="Send a message">
        <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2.5 text-xs text-slate-500">
          <span>
            Sent as <span className="font-medium text-brand-dark">{session.user.email}</span>
          </span>
          <span className="inline-flex items-center gap-1.5">
            <StatusBadge tone={STATUS_TONE[session.user.role]} className="text-[10px]">
              {roleLabel(session.user.role)}
            </StatusBadge>
            {region ? `${region.name} (${region.code})` : "No region set"}
          </span>
          <span>App version {appVersion}</span>
        </div>

        <SupportMessageForm action={submitSupportMessage} disabled={!recipients.ok} />
      </SectionCard>
    </div>
  );
}
