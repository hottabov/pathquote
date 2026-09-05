import { Receipt } from "lucide-react";
import { formatMoney } from "@/lib/format";
import { toCents, fromCents } from "@/lib/pricing";
import { SectionCard, EmptyState } from "@/components/ui-kit";
import { RemoveItemButton } from "@/components/builder/remove-item-button";
import { AddCustomLineForm } from "@/components/builder/add-custom-line-form";
import { removeLine } from "@/lib/actions/documents";
import type { BuilderLine } from "@/lib/queries/documents";

/**
 * The builder's "Extra" section (labeled "Extra lines" before this rename —
 * renamed to avoid confusion with the separate production-lines concept;
 * see the DocumentLine/`customLineSchema`/`addCustomLine` names below, which
 * are unchanged on purpose): every document-level CUSTOM line (delivery,
 * install, etc. — never an item's OPTION lines, which live on the item card
 * instead), each with its qty × unit price and line total, plus the add-line
 * form. `RemoveItemButton` is reused as-is here: it's already a generic
 * "call this action, confirm, show its error" control with no item-specific
 * logic.
 */
export function ExtraLinesSection({
  documentId,
  lines,
  currency,
  readOnly = false,
}: {
  documentId: string;
  lines: BuilderLine[];
  currency: string;
  readOnly?: boolean;
}) {
  return (
    <SectionCard title="Extra">
      {lines.length === 0 ? (
        <EmptyState icon={Receipt} title="No extras yet" description="Add delivery, install, or other one-off charges below." />
      ) : (
        <div className="flex flex-col gap-2">
          {lines.map((line) => (
            <div
              key={line.id}
              className="flex items-center justify-between gap-3 rounded-xl border border-slate-200 p-3"
            >
              <div className="flex min-w-0 items-center gap-2">
                {line.showImage && line.imageUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={line.imageUrl}
                    alt={line.name}
                    className="size-12 shrink-0 rounded-lg border border-slate-200 object-contain"
                  />
                ) : null}
                <div className="flex min-w-0 flex-col">
                  <span className="truncate text-sm font-medium text-brand-dark">{line.name}</span>
                  {line.description ? (
                    <span className="truncate text-xs text-slate-500">{line.description}</span>
                  ) : null}
                  <span className="text-xs text-slate-500">
                    {line.qty} × {formatMoney(line.unitPrice, currency)}
                  </span>
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-1">
                <span className="text-sm font-medium tabular-nums text-brand-dark">
                  {formatMoney(fromCents(line.qty * toCents(line.unitPrice)), currency)}
                </span>
                {!readOnly && (
                  <RemoveItemButton action={removeLine.bind(null, line.id)} itemName={line.name} />
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {!readOnly && (
        <div className="mt-4">
          <AddCustomLineForm documentId={documentId} />
        </div>
      )}
    </SectionCard>
  );
}
