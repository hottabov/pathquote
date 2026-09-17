import { AlertTriangle } from "lucide-react";
import { formatDateAU } from "@/lib/format";

/**
 * The persistent banner shown while a quote carries edits the client hasn't
 * received (spec §4.4): set when a quote is unfinalized (or its signature
 * voided) after a version had already gone out, cleared on the next successful
 * send. Renders nothing when there's nothing outstanding, so the caller can
 * mount it unconditionally.
 */
export function UnsentChangesBanner({
  hasUnsentChanges,
  sentAt,
  label,
}: {
  hasUnsentChanges: boolean;
  sentAt: Date | null;
  label: string | null;
}) {
  if (!hasUnsentChanges) return null;
  const lastSent = label && sentAt ? ` The last version sent to the client was ${label} on ${formatDateAU(sentAt)}.` : "";
  return (
    <div
      role="status"
      className="flex items-start gap-2 rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900"
    >
      <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
      <p>
        There are changes that haven&apos;t been sent to the client.{lastSent} You&apos;ll need to send the
        quotation again.
      </p>
    </div>
  );
}
