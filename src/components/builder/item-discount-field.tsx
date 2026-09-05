"use client";

import { useState } from "react";
import { AutosaveIndicator } from "@/components/builder/autosave-indicator";
import { fieldInputClass } from "@/components/ui-kit";
import { useAutosave } from "@/lib/use-autosave";
import { currencySymbol, formatMoney } from "@/lib/format";
import { cn } from "@/lib/utils";
import { setItemDiscount } from "@/lib/actions/documents";
import type { DiscountMode } from "@/lib/pricing";

/**
 * Inline "Discount" field on an item card, with a mode toggle (`%` / the
 * document's currency symbol — see `currencySymbol`) beside the number
 * input. Autosaves `setItemDiscount` 800ms after either the mode or the
 * value stops changing (see src/lib/use-autosave.ts) — no Save button — an
 * empty value clears the discount. The document's region cap (if any) is
 * shown as a hint; it's always a plain percentage regardless of which mode
 * the discount itself is in (see `setItemDiscount`'s doc comment for how a
 * cash discount is converted back to an effective percentage for the cap
 * check).
 *
 * Switching mode clears the value rather than converting it (owner: a
 * converted number invites the salesperson to accept a figure they did not
 * choose) — see `switchMode` below.
 *
 * A save that exceeds the cap behaves differently by role (enforced
 * server-side in `setItemDiscount`, not here): for a MANAGER it's rejected
 * outright with an error naming both the entered discount and the
 * percentage it works out to, surfaced by the autosave indicator turning
 * into that message; for an ADMIN it still saves, and the action instead
 * comes back with `warning` set — no longer surfaced here as a toast on
 * every such save (that was the "shouting on every save" the owner flagged;
 * this field just drops it now). The *document-level* concession the save
 * pushed things toward is instead the Summary panel's persistent badge plus
 * a one-time transition toast — see `ConcessionCapBadge`/`ConcessionCapToast`
 * in `[documentId]/page.tsx` — which is state that belongs on screen, not a
 * per-field message that disappears.
 */
export function ItemDiscountField({
  itemId,
  discountMode,
  discountValue,
  maxDiscountPct,
  currency,
  readOnly = false,
}: {
  itemId: string;
  discountMode: DiscountMode;
  discountValue: string | null;
  maxDiscountPct: string | null;
  currency: string;
  readOnly?: boolean;
}) {
  const [mode, setMode] = useState<DiscountMode>(discountMode);
  const [value, setValue] = useState(discountValue ?? "");

  // A single composite string so one autosave debounce covers both fields —
  // onSave re-derives mode/value from the value that actually changed
  // (rather than closing over `mode`/`value` from render scope) so a rapid
  // mode-then-value edit can never save a stale pairing. "|" is a safe
  // separator: DiscountMode is a fixed enum and a discount value only ever
  // contains digits and a decimal point (see discountValueSchema).
  const { status, error } = useAutosave({
    value: `${mode}|${value}`,
    enabled: !readOnly,
    onSave: async (composite) => {
      const [nextMode, nextValue] = composite.split("|");
      const formData = new FormData();
      formData.set("mode", nextMode);
      formData.set("value", nextValue);
      const result = await setItemDiscount(itemId, formData);
      return result.error ? { error: result.error } : {};
    },
  });

  function switchMode(next: DiscountMode) {
    if (next === mode) return;
    setMode(next);
    setValue("");
  }

  if (readOnly) {
    // An explicit `0` discount must not read as a discount here either —
    // same "must not print" rule as the customer-facing sheet (see
    // `buildItemBreakdown` in src/lib/sheet-data.ts).
    if (!discountValue || Number(discountValue) === 0) return null;
    const label = discountMode === "PERCENT" ? `${discountValue}%` : formatMoney(discountValue, currency);
    return <span className="text-xs text-slate-500">Discount: {label}</span>;
  }

  const symbol = currencySymbol(currency);

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <label
          htmlFor={`${itemId}-item-discount`}
          className="flex items-center gap-1.5 text-xs font-medium text-slate-500"
        >
          Discount
          <input
            id={`${itemId}-item-discount`}
            type="text"
            inputMode="decimal"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder="0"
            className={cn(fieldInputClass, "h-11 w-16 text-right sm:h-9")}
          />
        </label>
        <div
          role="group"
          aria-label="Discount type"
          className="flex overflow-hidden rounded-md border border-slate-200 text-xs font-medium"
        >
          <button
            type="button"
            onClick={() => switchMode("PERCENT")}
            aria-pressed={mode === "PERCENT"}
            className={cn(
              "h-8 px-2 sm:h-7",
              mode === "PERCENT" ? "bg-brand-dark text-white" : "bg-white text-slate-500"
            )}
          >
            %
          </button>
          <button
            type="button"
            onClick={() => switchMode("AMOUNT")}
            aria-pressed={mode === "AMOUNT"}
            className={cn(
              "h-8 border-l border-slate-200 px-2 sm:h-7",
              mode === "AMOUNT" ? "bg-brand-dark text-white" : "bg-white text-slate-500"
            )}
          >
            {symbol}
          </button>
        </div>
        {maxDiscountPct ? (
          <span className="text-[11px] text-slate-400">max {maxDiscountPct}%</span>
        ) : null}
        <AutosaveIndicator status={status} error={error} />
      </div>
    </div>
  );
}
