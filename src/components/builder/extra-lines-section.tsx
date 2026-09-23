import { ListPlus, Receipt } from "lucide-react";
import { SectionCard, EmptyState } from "@/components/ui-kit";
import { AddCustomLineForm } from "@/components/builder/add-custom-line-form";
import { ExtraLineRow } from "@/components/builder/extra-line-row";
import type { BuilderLine } from "@/lib/queries/documents";

/**
 * The builder's "Extra" section (labeled "Extra lines" before this rename —
 * renamed to avoid confusion with the separate production-lines concept;
 * see the DocumentLine/`customLineSchema`/`addCustomLine` names below, which
 * are unchanged on purpose): every document-level CUSTOM line (delivery,
 * install, etc. — never an item's OPTION lines, which live on the item card
 * instead), each with its qty × unit price and line total, plus the add-line
 * form. Each row can be edited in place -- see `ExtraLineRow`, which is where the
 * per-row state lives so this section can stay a server component.
 */
export function ExtraLinesSection({
  documentId,
  lines,
  currency,
  currencySymbol,
  readOnly = false,
}: {
  documentId: string;
  lines: BuilderLine[];
  currency: string;
  currencySymbol: string | null;
  readOnly?: boolean;
}) {
  return (
    <SectionCard title="Extra" icon={<ListPlus className="size-5" />}>
      {lines.length === 0 ? (
        <EmptyState icon={Receipt} title="No extras yet" description="Add delivery, install, or other one-off charges below." />
      ) : (
        <div className="flex flex-col gap-2">
          {lines.map((line) => (
            <ExtraLineRow
              key={line.id}
              documentId={documentId}
              line={line}
              currency={currency}
              currencySymbol={currencySymbol}
              readOnly={readOnly}
            />
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
