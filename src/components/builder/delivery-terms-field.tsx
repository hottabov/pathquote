"use client";

import { useState } from "react";
import { AutosaveIndicator } from "@/components/builder/autosave-indicator";
import { fieldInputClass } from "@/components/ui-kit";
import { useAutosave } from "@/lib/use-autosave";
import { cn } from "@/lib/utils";
import { setDeliveryTerms } from "@/lib/actions/documents";

type DeliveryTerms = "DELIVERED" | "EX_WORKS";

const LABELS: Record<DeliveryTerms, string> = {
  DELIVERED: "Delivered",
  EX_WORKS: "Ex Works",
};

/**
 * The builder's delivery-terms selector — DELIVERED (the default) or
 * EX_WORKS, an export sale collected at the factory door and therefore not a
 * domestic taxable supply (the meeting question left unanswered: "What if
 * there's no GST? If it's Ex Works?"). Autosaved via `useAutosave`, same
 * pattern as `ValidityDaysField` (the closest neighbouring model): no Save
 * button, calls `setDeliveryTerms` 800ms after the selection settles.
 *
 * Unlike `ValidityDaysField`, this one changes what's owed — flipping to
 * EX_WORKS zeroes the document's tax (see `recalcDocument` in
 * src/lib/actions/documents.ts) — so the quotation sheet (see
 * `quotation-sheet.tsx`) prints the terms next to the totals instead of a
 * `{taxName} 0%` line once this is set.
 */
export function DeliveryTermsField({
  documentId,
  deliveryTerms,
  readOnly = false,
}: {
  documentId: string;
  deliveryTerms: DeliveryTerms;
  readOnly?: boolean;
}) {
  const [value, setValue] = useState<DeliveryTerms>(deliveryTerms);

  const { status, error } = useAutosave({
    value,
    enabled: !readOnly,
    onSave: async (next) => {
      const formData = new FormData();
      formData.set("deliveryTerms", next);
      return setDeliveryTerms(documentId, formData);
    },
  });

  if (readOnly) {
    return (
      <p className="text-sm text-slate-700">
        {LABELS[deliveryTerms]}
        {deliveryTerms === "EX_WORKS" ? " — no GST applicable." : "."}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="delivery-terms" className="text-sm text-slate-500">
          Terms
        </label>
        <select
          id="delivery-terms"
          value={value}
          onChange={(e) => setValue(e.target.value as DeliveryTerms)}
          className={cn(fieldInputClass, "h-11 w-auto sm:h-10")}
        >
          <option value="DELIVERED">Delivered</option>
          <option value="EX_WORKS">Ex Works</option>
        </select>
        <AutosaveIndicator status={status} error={error} />
      </div>
      {/* Explains *why* there's no tax, so an Ex Works quote reads as
          deliberate rather than a rate someone forgot to set — same reason
          the sheet prints this instead of a "GST 0%" line (see
          quotation-sheet.tsx). */}
      {value === "EX_WORKS" ? (
        <p className="text-xs text-slate-500">
          An export sale collected at the factory door isn&rsquo;t a domestic taxable supply — no GST is charged
          on this quote.
        </p>
      ) : null}
    </div>
  );
}
