"use client";

import { useState } from "react";
import { AutosaveIndicator } from "@/components/builder/autosave-indicator";
import { fieldInputClass } from "@/components/ui-kit";
import { useAutosave } from "@/lib/use-autosave";
import { cn } from "@/lib/utils";
import { setValidityDays } from "@/lib/actions/documents";

/** The sales-guideline norm the inline warning below is measured against —
 * NOT enforced (see `validityDaysSchema`, which allows up to 365): the
 * discount cap already covers the case where money is actually at risk, and
 * a slower customer capex process (owner: "I'll give you eight [weeks]") is
 * a legitimate reason to exceed it. */
const RECOMMENDED_MAX_DAYS = 30;

/**
 * The builder's "Valid for N days" field — a per-quote override of the
 * org-wide `quote.validityDays` setting (see `getQuoteValidityDays`,
 * src/lib/queries/settings.ts), autosaved via `useAutosave` the same way
 * `NotesSection`/`DocumentDiscountField` are (no Save button, calls
 * `setValidityDays` 800ms after typing settles).
 *
 * An empty field means "use the org-wide setting" (mirrors
 * `validityDaysSchema`'s null-on-blank behavior) — shown as a placeholder of
 * the current org default rather than a filled-in value, so a document with
 * no override of its own visibly tracks whatever admins set on /settings
 * without the builder needing to duplicate that value into every draft.
 */
export function ValidityDaysField({
  documentId,
  validityDays,
  orgDefaultDays,
  readOnly = false,
}: {
  documentId: string;
  validityDays: number | null;
  orgDefaultDays: number;
  readOnly?: boolean;
}) {
  const [value, setValue] = useState(validityDays !== null ? String(validityDays) : "");

  const { status, error } = useAutosave({
    value,
    enabled: !readOnly,
    onSave: async (next) => {
      const formData = new FormData();
      formData.set("validityDays", next);
      return setValidityDays(documentId, formData);
    },
  });

  const numeric = value.trim() === "" ? null : Number(value);
  const showWarning = numeric !== null && Number.isFinite(numeric) && numeric > RECOMMENDED_MAX_DAYS;

  if (readOnly) {
    const days = validityDays ?? orgDefaultDays;
    return <p className="text-sm text-slate-700">Valid for {days} days.</p>;
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-2">
        <label htmlFor="validity-days" className="text-sm text-slate-500">
          Valid for
        </label>
        <input
          id="validity-days"
          type="text"
          inputMode="numeric"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder={String(orgDefaultDays)}
          className={cn(fieldInputClass, "h-11 w-20 sm:h-10")}
        />
        <span className="text-sm text-slate-500">days</span>
        <AutosaveIndicator status={status} error={error} />
      </div>
      {/* Non-blocking — a sales guideline, not a hard rule; the field still
          saves normally above 30. */}
      {showWarning ? (
        <p className="text-xs text-amber-600">
          Longer than the usual {RECOMMENDED_MAX_DAYS}-day window — fine for a slower capex approval, just flagging it.
        </p>
      ) : null}
    </div>
  );
}
