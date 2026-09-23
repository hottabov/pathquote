import { AlertTriangle, Download, Factory, FileText } from "lucide-react";
import { SectionCard } from "@/components/ui-kit";
import { buildFormContexts, softwareItemsOnDocument } from "@/lib/production-forms/context";
import { pathWorksModulesWithoutHost } from "@/lib/production-forms/pathworks";
import { missingRequirements, resolveForm, unmatchedOptions } from "@/lib/production-forms/resolve";
import type { FormContext } from "@/lib/production-forms/types";
import type { DocumentForForms } from "@/lib/queries/documents";

const pdfLinkClass =
  "focus-ring inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border border-slate-200 bg-white px-3 text-sm font-medium text-brand-dark transition-colors hover:bg-slate-50";

const downloadAllClass =
  "focus-ring flex h-11 w-full items-center justify-center gap-2 rounded-lg bg-brand text-sm font-medium text-white transition-colors hover:bg-brand/90 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-400 sm:w-auto sm:px-6";

/**
 * The download row for a quote's Additional items page — the document-level
 * custom lines plus any option no machine form has a box for. Shared between
 * the readiness list and the no-machine-forms case (a quote of only custom
 * lines) so the two never drift; `?item=extras` renders exactly this page.
 */
function AdditionalItemsRow({ documentId, count }: { documentId: string; count: number }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-2.5">
      <span className="text-sm text-brand-dark">
        Additional items <span className="text-slate-400">({count})</span>
      </span>
      <a href={`/api/quotes/${documentId}/production-forms?item=extras`} className={pdfLinkClass}>
        <FileText className="size-4" aria-hidden="true" />
        PDF
      </a>
    </li>
  );
}

/**
 * The Software Order Form's row -- one sheet per quote listing the software
 * sold on it, Martin's order rather than the workshop's. `?item=software`
 * renders exactly this page.
 */
function SoftwareRow({ documentId, count }: { documentId: string; count: number }) {
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 py-2.5">
      <span className="text-sm text-brand-dark">
        Software order form <span className="text-slate-400">({count})</span>
      </span>
      <a href={`/api/quotes/${documentId}/production-forms?item=software`} className={pdfLinkClass}>
        <FileText className="size-4" aria-hidden="true" />
        PDF
      </a>
    </li>
  );
}

/**
 * Readiness list plus the download links for a finalized quote's production
 * forms. Returns `null` for anything that is not FINAL, mirroring
 * exactly the check `/api/quotes/[documentId]/production-forms` makes —
 * mounted unconditionally at the call site, no status check needed there.
 *
 * `missingRequirements` and the "extras" page count below reuse the same
 * helpers the route calls at request time (`unmatchedOptions`, plus
 * `document.lines.length` for document-level custom lines) so the "Download
 * all forms (N pages)" label and the disabled state can never promise a page
 * count, or a readiness state, the route wouldn't actually produce.
 */
export function ProductionFormsSection({ document }: { document: DocumentForForms }) {
  if (document.status !== "FINAL") return null;

  const contexts = buildFormContexts(document);
  const software = softwareItemsOnDocument(document);

  return (
    <SectionCard title="Order forms" icon={<Factory className="size-5" />}>
      {contexts.length === 0 ? (
        software.length > 0 || document.lines.length > 0 ? (
          // No machine forms, but the quote still has software to order or
          // custom line items to send on as their own page.
          <ul className="flex flex-col divide-y divide-slate-100">
            {software.length > 0 ? <SoftwareRow documentId={document.id} count={software.length} /> : null}
            {document.lines.length > 0 ? (
              <AdditionalItemsRow documentId={document.id} count={document.lines.length} />
            ) : null}
          </ul>
        ) : (
          <p className="text-sm text-slate-500">No order forms apply to this quote.</p>
        )
      ) : (
        <ProductionFormsBody document={document} contexts={contexts} software={software} />
      )}
    </SectionCard>
  );
}

function ProductionFormsBody({
  document,
  contexts,
  software,
}: {
  document: DocumentForForms;
  contexts: FormContext[];
  software: Array<{ code: string }>;
}) {
  const rows = contexts.map((ctx) => {
    const spec = resolveForm(ctx.item.form)!;
    return { ctx, spec, missing: missingRequirements(spec, ctx.item.spec) };
  });

  const blocked = rows.some((row) => row.missing.length > 0);

  // Same arithmetic as the route: document-level lines plus every option no
  // form has a box for. Counting it differently here would let the button
  // promise a page count the PDF does not deliver.
  const extras =
    document.lines.length +
    rows.reduce((total, row) => total + unmatchedOptions(row.spec, row.ctx).length, 0);

  // Shared with the builder's readiness rail, which now raises the same
  // remark while the quote is still a draft -- see
  // `pathWorksModulesWithoutHost`.
  const modulesWithoutHost = pathWorksModulesWithoutHost(contexts[0].software);

  return (
    <div className="flex flex-col gap-4">
      {modulesWithoutHost ? (
        <p className="flex items-start gap-2 rounded-lg bg-amber-50 p-3 text-sm text-amber-700">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          PathWorks modules are on this quote with no PathWorks licence to host them.
        </p>
      ) : null}

      <ul className="flex flex-col divide-y divide-slate-100">
        {rows.map(({ ctx, spec, missing }) => (
          <li key={ctx.item.id} className="flex flex-wrap items-center justify-between gap-2 py-2.5">
            <span className="text-sm text-brand-dark">
              {spec.title} <span className="text-slate-400">—</span>{" "}
              <span className="font-mono text-xs text-slate-500">{ctx.item.code}</span>
            </span>
            {missing.length === 0 ? (
              <a href={`/api/quotes/${document.id}/production-forms?item=${ctx.item.id}`} className={pdfLinkClass}>
                <FileText className="size-4" aria-hidden="true" />
                PDF
              </a>
            ) : (
              <span className="inline-flex items-center rounded-full bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">
                missing: {missing.join(", ")}
              </span>
            )}
          </li>
        ))}
        {software.length > 0 ? <SoftwareRow documentId={document.id} count={software.length} /> : null}
        {extras > 0 ? <AdditionalItemsRow documentId={document.id} count={extras} /> : null}
      </ul>

      {blocked ? (
        <button type="button" disabled className={downloadAllClass}>
          <Download className="size-4" aria-hidden="true" />
          Download all forms
        </button>
      ) : (
        <a href={`/api/quotes/${document.id}/production-forms`} className={downloadAllClass}>
          <Download className="size-4" aria-hidden="true" />
          Download all forms ({rows.length + (software.length > 0 ? 1 : 0) + (extras > 0 ? 1 : 0)} pages)
        </a>
      )}
    </div>
  );
}
