import { AlertTriangle, Send } from "lucide-react";
import { SectionCard } from "@/components/ui-kit";
import { ActAdminActions } from "@/components/documents/act-admin-actions";
import { adminActionsFor } from "@/lib/act/outbox-admin";
import { ACT_CARD_TITLE, LAST_ERROR_LABEL, adminHelpFor, describeQuoteAct } from "@/lib/act/quote-act-view";
import type { QuoteActState } from "@/lib/queries/act-quote";
import { cn } from "@/lib/utils";

/**
 * The two tones describeQuoteAct returns, as the Settings section's queue
 * card shows them (SUMMARY_TONE in src/app/(app)/settings/act-sync/page.tsx),
 * so amber on the quote means what amber means there: held until somebody
 * acts.
 */
const TONE = {
  ok: "border-slate-200 bg-slate-50 text-slate-700",
  warn: "border-amber-300 bg-amber-50 text-amber-800",
} as const;

/**
 * Where a quote's write into ACT! stands, on the quote's own page, beside the
 * signing card -- and, for an administrator, what can be done about it.
 *
 * Every sentence comes from describeQuoteAct and adminHelpFor
 * (src/lib/act/quote-act-view.ts); this decides how a tone looks and nothing
 * else. Renders nothing for a quote the card has nothing to say about (a
 * draft with nothing unfinished).
 *
 * `isAdmin` decides the administrator's note and buttons, and only those:
 * everyone who can open the quote reads the state. The actions check
 * requireAdmin on the server whatever is rendered here.
 */
export function ActStateCard({
  state,
  isAdmin,
  documentId,
  now,
}: {
  state: QuoteActState;
  isAdmin: boolean;
  documentId: string;
  /** The page's clock, passed in so the card renders from one reading of it. */
  now: Date;
}) {
  const view = describeQuoteAct(state.facts, now);
  if (!view) return null;

  const actions = adminActionsFor(state.row, state.contact);
  const offered = isAdmin && (actions.tryAgain || actions.contactFound || actions.contactAbsent || actions.dontSend);

  return (
    <SectionCard title={ACT_CARD_TITLE} icon={<Send className="size-5" />}>
      <div className="flex flex-col gap-3 text-sm">
        <div className={cn("rounded-lg border px-3 py-2", TONE[view.tone])}>
          <p className="flex min-w-0 items-start gap-2">
            {view.tone === "ok" ? null : <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />}
            <span className="min-w-0 font-medium break-words">{view.headline}</span>
          </p>
          {/* `break-words`: a held reason can quote ACT!'s own answer, which
              can carry an unbroken token. */}
          {view.detail ? <p className="mt-1 break-words">{view.detail}</p> : null}
        </div>

        {view.facts.length > 0 ? (
          <dl className="flex flex-col gap-1.5 text-brand-dark">
            {view.facts.map((fact) => (
              <div key={fact.label}>
                <dt className="inline font-medium text-slate-500">{fact.label} </dt>
                <dd className="inline break-words">{fact.value}</dd>
              </div>
            ))}
          </dl>
        ) : null}

        {view.lastError ? (
          <div className="text-slate-600">
            <p className="text-xs font-semibold tracking-wide text-slate-500 uppercase">{LAST_ERROR_LABEL}</p>
            <p className="mt-1 break-words">{view.lastError}</p>
          </div>
        ) : null}

        {isAdmin && view.adminNote ? <p className="text-slate-600">{view.adminNote}</p> : null}

        {offered ? (
          <div className="border-t border-divider pt-3">
            <ActAdminActions
              documentId={documentId}
              actions={actions}
              help={adminHelpFor({
                blockedBy: state.row?.blockedBy ?? null,
                contactName: state.facts.contact?.name ?? null,
                number: state.facts.number,
              })}
            />
          </div>
        ) : null}
      </div>
    </SectionCard>
  );
}
