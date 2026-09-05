"use client";

import { useState } from "react";
import { AutosaveIndicator } from "@/components/builder/autosave-indicator";
import { fieldInputClass } from "@/components/ui-kit";
import { useAutosave } from "@/lib/use-autosave";
import { currencySymbol, formatMoney } from "@/lib/format";
import { cn } from "@/lib/utils";
import { setDocumentDiscount } from "@/lib/actions/documents";
import type { DiscountMode } from "@/lib/pricing";

/**
 * The document-level "Discount" field, with the same mode toggle (`%` /
 * currency symbol) as `ItemDiscountField` — see its doc comment for the
 * autosave/mode-switch/cap-enforcement behavior, which this mirrors exactly
 * (`setDocumentDiscount` instead of `setItemDiscount`, and the cap is
 * checked against the document's subtotal rather than an item's base).
 * Lives in its own "Discounts" section on the builder page; the totals
 * breakdown shows the resulting discount amount once one is set.
 */
export function DocumentDiscountField({
  documentId,
  discountMode,
  discountValue,
  currency,
  readOnly = false,
}: {
  documentId: string;
  discountMode: DiscountMode;
  discountValue: string | null;
  currency: string;
  readOnly?: boolean;
}) {
  const [mode, setMode] = useState<DiscountMode>(discountMode);
  const [value, setValue] = useState(discountValue ?? "");

  // See ItemDiscountField's doc comment for why mode+value share one
  // composite autosave value, and for where the ADMIN-only concession-cap
  // `warning` this save can come back with is surfaced these days (the
  // Summary panel's persistent badge plus a one-time transition toast —
  // see ConcessionCapBadge/ConcessionCapToast — rather than a toast fired
  // from every field that happens to touch money).
  const { status, error } = useAutosave({
    value: `${mode}|${value}`,
    enabled: !readOnly,
    onSave: async (composite) => {
      const [nextMode, nextValue] = composite.split("|");
      const formData = new FormData();
      formData.set("mode", nextMode);
      formData.set("value", nextValue);
      const result = await setDocumentDiscount(documentId, formData);
      return result.error ? { error: result.error } : {};
    },
  });

  function switchMode(next: DiscountMode) {
    if (next === mode) return;
    setMode(next);
    setValue("");
  }

  if (readOnly) {
    // An explicit `0` discount reads the same as no discount at all — same
    // "must not print" rule as the customer-facing sheet (see
    // quotation-sheet.tsx).
    if (!discountValue || Number(discountValue) === 0)
      return <p className="text-sm text-slate-700">No document discount applied.</p>;
    const label = discountMode === "PERCENT" ? `${discountValue}% off the subtotal` : `${formatMoney(discountValue, currency)} off the subtotal`;
    return <p className="text-sm text-slate-700">{label}</p>;
  }

  const symbol = currencySymbol(currency);

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="document-discount" className="text-sm text-slate-500">
          Discount
        </label>
        <input
          id="document-discount"
          type="text"
          inputMode="decimal"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="0"
          className={cn(fieldInputClass, "h-11 w-24 sm:h-10")}
        />
        <div
          role="group"
          aria-label="Discount type"
          className="flex overflow-hidden rounded-md border border-slate-200 text-sm font-medium"
        >
          <button
            type="button"
            onClick={() => switchMode("PERCENT")}
            aria-pressed={mode === "PERCENT"}
            className={cn("h-10 px-3", mode === "PERCENT" ? "bg-brand-dark text-white" : "bg-white text-slate-500")}
          >
            %
          </button>
          <button
            type="button"
            onClick={() => switchMode("AMOUNT")}
            aria-pressed={mode === "AMOUNT"}
            className={cn(
              "h-10 border-l border-slate-200 px-3",
              mode === "AMOUNT" ? "bg-brand-dark text-white" : "bg-white text-slate-500"
            )}
          >
            {symbol}
          </button>
        </div>
        <AutosaveIndicator status={status} error={error} />
      </div>
    </div>
  );
}
