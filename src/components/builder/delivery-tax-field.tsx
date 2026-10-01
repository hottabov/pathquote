"use client";

import { useState } from "react";
import { AutosaveIndicator } from "@/components/builder/autosave-indicator";
import { ReadOnlyValue, fieldInputClass } from "@/components/ui-kit";
import { useAutosave } from "@/lib/use-autosave";
import { cn } from "@/lib/utils";
import { setDocumentTax, setIncoterm } from "@/lib/actions/documents";
import { countryName } from "@/lib/countries";
import {
  INCOTERMS,
  INCOTERM_LABELS,
  type Incoterm,
  type TaxSuggestion,
  type TaxTreatment,
} from "@/lib/documents/tax-rules";
import { taxBannerNote } from "@/lib/documents/tax-print";

type Mode = "AUTO" | "CUSTOM";

function rateText(rate: string): string {
  return String(Number(rate));
}

function suggestionLabel(s: TaxSuggestion): string {
  switch (s.treatment) {
    case "EXPORT":
      return `Export — no ${s.taxName} (0%)`;
    case "REVERSE_CHARGE":
      return `Reverse charge — no ${s.taxName} (0%)`;
    case "STANDARD":
      return `${s.taxName} ${rateText(s.taxRate)}%`;
  }
}

function place(code: string | null): string {
  if (!code) return "delivery country not set";
  return countryName(code) ?? code;
}

/**
 * The builder's "Delivery & tax" card (Setup tab): the Incoterm, the route
 * it applies to, and the tax — Auto (the app's suggestion, with its reason)
 * or Custom (the salesperson's own name, rate and reason). Both halves
 * autosave like every neighbouring field; the tax half saves one JSON
 * payload so the three custom inputs travel together.
 *
 * Decisions: Vadym, 2026-09-30 — docs/superpowers/specs/2026-09-30-tax-and-incoterms-design.md.
 */
export function DeliveryTaxField({
  documentId,
  incoterm: initialIncoterm,
  taxTreatment,
  taxName,
  taxRate,
  taxOverridden,
  taxNote,
  suggestion,
  blocker,
  sellerCountry,
  destinationCountry,
  readOnly = false,
}: {
  documentId: string;
  incoterm: Incoterm;
  taxTreatment: TaxTreatment;
  taxName: string;
  taxRate: string;
  taxOverridden: boolean;
  taxNote: string | null;
  suggestion: TaxSuggestion;
  blocker: string | null;
  sellerCountry: string;
  destinationCountry: string | null;
  readOnly?: boolean;
}) {
  const [incoterm, setIncotermValue] = useState<Incoterm>(initialIncoterm);
  const [mode, setMode] = useState<Mode>(taxOverridden ? "CUSTOM" : "AUTO");
  const [customName, setCustomName] = useState(taxOverridden ? taxName : suggestion.taxName);
  const [customRate, setCustomRate] = useState(taxOverridden ? rateText(taxRate) : rateText(suggestion.taxRate));
  const [customNote, setCustomNote] = useState(taxNote ?? "");

  const incotermSave = useAutosave({
    label: "incoterm",
    value: incoterm,
    enabled: !readOnly,
    onSave: async (next) => {
      const formData = new FormData();
      formData.set("incoterm", next);
      return setIncoterm(documentId, formData);
    },
  });

  // A string, not an object: useAutosave compares with ===.
  const taxPayload =
    mode === "AUTO"
      ? JSON.stringify({ mode })
      : JSON.stringify({ mode, taxName: customName, taxRate: customRate, taxNote: customNote });

  const taxSave = useAutosave({
    label: "tax",
    value: taxPayload,
    enabled: !readOnly,
    onSave: async (payload) => {
      const formData = new FormData();
      for (const [key, value] of Object.entries(JSON.parse(payload) as Record<string, string>)) {
        formData.set(key, value);
      }
      return setDocumentTax(documentId, formData);
    },
  });

  if (readOnly) {
    const line = taxBannerNote({ incoterm, taxTreatment, taxName, taxRate, customerTaxId: null }).slice(1, -1);
    return <ReadOnlyValue>{line}.</ReadOnlyValue>;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <label htmlFor="incoterm" className="text-xs font-medium text-slate-500">
          Incoterm
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <select
            id="incoterm"
            value={incoterm}
            onChange={(e) => setIncotermValue(e.target.value as Incoterm)}
            className={cn(fieldInputClass, "h-11 w-auto sm:h-10")}
          >
            {INCOTERMS.map((code) => (
              <option key={code} value={code}>
                {code} — {INCOTERM_LABELS[code]}
              </option>
            ))}
          </select>
          <AutosaveIndicator status={incotermSave.status} error={incotermSave.error} />
        </div>
        <p className="text-xs text-slate-500">
          Route: {place(sellerCountry)} → {place(destinationCountry)} <span className="text-slate-400">(from client)</span>
        </p>
      </div>

      <fieldset className="flex flex-col gap-2">
        {/* The indicator sits outside the legend so the fieldset's accessible
            name is just "Tax", not "Tax Saving…". */}
        <legend className="mb-1 text-xs font-medium text-slate-500">Tax</legend>
        <div className="flex items-center">
          <AutosaveIndicator status={taxSave.status} error={taxSave.error} />
        </div>

        <label className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name="tax-mode"
            value="AUTO"
            checked={mode === "AUTO"}
            onChange={() => {
              setMode("AUTO");
              // Back to the suggestion, so choosing Custom again starts from
              // it rather than silently re-saving an old name, rate or reason.
              setCustomName(suggestion.taxName);
              setCustomRate(rateText(suggestion.taxRate));
              setCustomNote("");
            }}
            className="mt-1"
          />
          <span className="flex flex-col">
            <span>
              Auto <span className="font-medium text-slate-800">{suggestionLabel(suggestion)}</span>
            </span>
            <span className="text-xs text-slate-500">{suggestion.reason}</span>
            {suggestion.hint ? <span className="text-xs text-slate-500">{suggestion.hint}</span> : null}
          </span>
        </label>

        <label className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name="tax-mode"
            value="CUSTOM"
            checked={mode === "CUSTOM"}
            onChange={() => setMode("CUSTOM")}
            className="mt-1"
          />
          <span>Custom</span>
        </label>

        {mode === "CUSTOM" ? (
          <div className="ml-6 flex flex-col gap-2">
            <div className="flex flex-wrap gap-2">
              <label className="flex flex-col gap-1 text-xs text-slate-500">
                Name
                <input
                  value={customName}
                  onChange={(e) => setCustomName(e.target.value)}
                  maxLength={40}
                  placeholder="Sales Tax (Texas)"
                  className={cn(fieldInputClass, "h-10 w-56")}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-slate-500">
                Rate %
                <input
                  value={customRate}
                  onChange={(e) => setCustomRate(e.target.value)}
                  inputMode="decimal"
                  className={cn(fieldInputClass, "h-10 w-24")}
                />
              </label>
            </div>
            <label className="flex flex-col gap-1 text-xs text-slate-500">
              Reason (internal, required to finalize)
              <input
                value={customNote}
                onChange={(e) => setCustomNote(e.target.value)}
                maxLength={200}
                placeholder="Delivered to Austin, TX"
                className={cn(fieldInputClass, "h-10")}
              />
            </label>
            <p className="text-xs text-slate-500">Auto would charge: {suggestionLabel(suggestion)}</p>
          </div>
        ) : null}
      </fieldset>

      {blocker ? (
        <p role="status" className="text-xs font-medium text-amber-700">
          {blocker}
        </p>
      ) : null}
    </div>
  );
}
