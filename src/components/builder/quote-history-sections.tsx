import { Download, History, Mail } from "lucide-react";
import {
  EmptyState,
  SectionCard,
  StatusBadge,
  tableClassName,
  tableHeadRowClassName,
  tableRowClassName,
} from "@/components/ui-kit";
import { formatDateAU, formatMoney } from "@/lib/format";
import type { QuoteRevisionRow, QuoteEmailRow } from "@/lib/queries/quote-revisions";

/** A consistent, fixed-size download button so the control never shifts with
 * the length of the text beside it (it always reads "PDF" with the icon). */
const pdfButtonClass =
  "focus-ring inline-flex items-center gap-1.5 rounded-md border border-slate-200 px-2.5 py-1 text-xs font-medium text-brand-dark transition-colors md:hover:bg-slate-50";

/**
 * The Revisions tab (spec §5): one row per frozen revision — label, date,
 * author, total, and a link to that revision's PDF. The revision the client
 * signed carries a badge. Renders nothing until a quote has been finalized at
 * least once, so the caller can mount it unconditionally. Diff between
 * revisions is deliberately out of scope for this stage.
 */
export function RevisionsSection({
  revisions,
  documentId,
  currency,
  currencySymbol,
}: {
  revisions: QuoteRevisionRow[];
  documentId: string;
  currency: string;
  currencySymbol: string | null;
}) {
  // The card stays even with nothing in it. It used to return null, and on
  // a quote that had never been finalised that left the whole History tab
  // blank -- which does not read as "nothing has happened yet", it reads as
  // a page that failed to load.
  if (revisions.length === 0) {
    return (
      <SectionCard title="Revisions" icon={<History className="size-5" />}>
        <EmptyState
          icon={History}
          title="No revisions yet"
          description="Each time this quote is finalised, the version sent to the client is kept here as a PDF."
          bordered={false}
          compact
        />
      </SectionCard>
    );
  }

  const pdfHref = (id: string) => `/api/quotes/${documentId}/revisions/${id}/pdf`;
  const money = (total: string) => formatMoney(total, currency, currencySymbol);

  return (
    <SectionCard title="Revisions" icon={<History className="size-5" />}>
      {/* desktop table */}
      <div className="hidden overflow-x-auto rounded-xl border border-slate-200 bg-white md:block">
        <table className={tableClassName}>
          <thead>
            <tr className={tableHeadRowClassName}>
              <th className="px-4 py-2">Version</th>
              <th className="px-4 py-2">Date</th>
              <th className="px-4 py-2">By</th>
              <th className="px-4 py-2 text-right">Total</th>
              <th className="px-4 py-2 text-right">PDF</th>
            </tr>
          </thead>
          <tbody>
            {revisions.map((r) => (
              <tr key={r.id} className={tableRowClassName}>
                <td className="px-4 py-3">
                  <span className="font-mono">{r.label}</span>
                  {r.isSigned ? (
                    <StatusBadge tone="green" className="ml-2">
                      Signed
                    </StatusBadge>
                  ) : null}
                </td>
                <td className="px-4 py-3 text-slate-600 whitespace-nowrap">{formatDateAU(r.createdAt)}</td>
                <td className="px-4 py-3 text-slate-600">{r.createdByName ?? "—"}</td>
                <td className="px-4 py-3 text-right font-medium whitespace-nowrap tabular-nums">{money(r.total)}</td>
                <td className="px-4 py-3 text-right">
                  {r.pdfPath || r.signedPdfPath ? (
                    <a href={pdfHref(r.id)} className={pdfButtonClass} target="_blank" rel="noreferrer">
                      <Download className="size-3.5" aria-hidden="true" />
                      PDF
                    </a>
                  ) : (
                    <span className="text-slate-400">—</span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* mobile stacked list — the download button is pinned to the right of
          each card (a fixed-width flex child) so it never shifts with the
          total or date length beside it. */}
      <div className="flex flex-col gap-3 md:hidden">
        {revisions.map((r) => (
          <div key={r.id} className="flex items-start justify-between gap-3 rounded-lg border border-slate-200 bg-white p-3 text-sm">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="font-mono">{r.label}</span>
                {r.isSigned ? <StatusBadge tone="green">Signed</StatusBadge> : null}
              </div>
              <div className="mt-1 text-slate-600">
                {formatDateAU(r.createdAt)} · {r.createdByName ?? "—"}
              </div>
              <div className="mt-1 font-medium tabular-nums">{money(r.total)}</div>
            </div>
            {r.pdfPath || r.signedPdfPath ? (
              <a href={pdfHref(r.id)} className={`${pdfButtonClass} shrink-0`} target="_blank" rel="noreferrer">
                <Download className="size-3.5" aria-hidden="true" />
                PDF
              </a>
            ) : null}
          </div>
        ))}
      </div>
    </SectionCard>
  );
}

/**
 * The send history (spec §7): who the quote was emailed to, when, which
 * revision, with the exact text the manager sent expandable inline (a native
 * <details>, so no client JS). Renders nothing until at least one send.
 */
export function EmailHistorySection({ emails }: { emails: QuoteEmailRow[] }) {
  if (emails.length === 0) return null;

  return (
    <SectionCard title="Emails sent" icon={<Mail className="size-5" />}>
      <ul className="flex flex-col gap-3">
        {emails.map((e) => (
          <li key={e.id} className="rounded-lg border border-slate-200 bg-white p-3 text-sm">
            <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
              <span className="font-medium text-slate-800">{e.subject}</span>
              <span className="text-slate-500">{formatDateAU(e.sentAt)}</span>
            </div>
            <div className="mt-1 text-slate-600">
              To {e.to.join(", ")}
              {e.cc.length ? ` · Cc ${e.cc.join(", ")}` : ""}
              {e.revisionLabel ? ` · ${e.revisionLabel}` : ""}
              {e.sentByName ? ` · sent by ${e.sentByName}` : ""}
            </div>
            <details className="mt-2">
              <summary className="cursor-pointer text-brand-dark">Show message</summary>
              <pre className="mt-2 whitespace-pre-wrap font-sans text-slate-700">{e.bodyText}</pre>
            </details>
          </li>
        ))}
      </ul>
    </SectionCard>
  );
}
