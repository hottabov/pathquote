"use client";

import { useState, useTransition, type FormEvent } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fieldInputClass } from "@/components/ui-kit";
import { useToast } from "@/components/ui-kit/client";
import { cn } from "@/lib/utils";
import type { CommissionTier } from "@/lib/pricing";
import type { ActionResult } from "@/lib/actions/settings";

const MAX_ROWS = 12;

/** Both columns and the remove button, shared by the header row and every
 * tier row so they line up by construction. On a phone this is a 2-column,
 * 2-row grid — discount above commission on the left, the remove button
 * pinned to the right and spanning both rows — so each field stays a single
 * compact line instead of stretching full-width. At sm+ it reverts to the
 * three-column row (discount | commission | remove). */
const TIER_GRID =
  "grid grid-cols-[minmax(0,1fr)_2.75rem] grid-rows-[auto_auto] items-center gap-x-3 gap-y-1.5 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_2.75rem] sm:grid-rows-none sm:gap-3";

/** The percentage a row starts at: 0 for the first, one hundredth past the
 * row above for the rest — the same derivation `toTiers` performs, shown to
 * the admin so each row reads as the range it is rather than a lone number.
 * Rendered, never submitted. */
function lowerBoundOf(rows: TierRow[], index: number): number {
  let minPct = 0;
  for (let i = 0; i < index; i++) {
    const upTo = Number(rows[i].upToPct);
    minPct = Math.round(((Number.isFinite(upTo) ? upTo : 0) + 0.01) * 100) / 100;
  }
  return minPct;
}

/** One edited row — only the upper bound and the rate are ever typed; a
 * row's `minPct` is always derived from the row before it (see `toTiers`
 * below), and the LAST row is always rendered as "and above" with no upper
 * bound at all. This is what makes the table impossible to submit with a
 * gap or an overlap through this editor: `validateCommissionTiers`
 * (src/lib/pricing.ts) still runs server-side on save, but a hand-typed
 * mistake here can only ever be "wrong boundary", never "disconnected
 * range". */
type TierRow = { id: string; upToPct: string; ratePct: string };

let rowCounter = 0;
function nextRowId(): string {
  rowCounter += 1;
  return `commission-tier-row-${rowCounter}`;
}

function rowsFromTiers(tiers: CommissionTier[]): TierRow[] {
  return tiers.map((tier) => ({
    id: nextRowId(),
    upToPct: tier.maxPct === null ? "" : String(tier.maxPct),
    ratePct: String(tier.ratePct),
  }));
}

/** Turns the edited rows into the `{minPct,maxPct,ratePct}[]` shape
 * `commissionTiersSchema`/`validateCommissionTiers` expect. `minPct` is
 * derived, not read from any input — 0 for the first row, and one
 * hundredth of a percent past the previous row's `maxPct` for every row
 * after that — and the last row's `maxPct` is always `null`, regardless of
 * what (if anything) its now-hidden upper-bound field once held. */
function toTiers(rows: TierRow[]): CommissionTier[] {
  let minPct = 0;
  return rows.map((row, index) => {
    const isLast = index === rows.length - 1;
    const upToPct = Number(row.upToPct);
    const maxPct = isLast ? null : Number.isFinite(upToPct) ? upToPct : 0;
    const ratePctRaw = Number(row.ratePct);
    const tier: CommissionTier = { minPct, maxPct, ratePct: Number.isFinite(ratePctRaw) ? ratePctRaw : 0 };
    if (maxPct !== null) minPct = Math.round((maxPct + 0.01) * 100) / 100;
    return tier;
  });
}

/**
 * ADMIN-only editor for the "commission.tiers" app setting (the discount %
 * -> commission % table — see `computeTotals`'s commission section,
 * src/lib/pricing.ts), rendered in the Preferences card on
 * /settings/preferences. Same transition+toast pattern as
 * `QuoteValidityForm` (a single explicit Save, not per-row autosave), with
 * a dynamic row editor mirroring `BankDetailsEditor`
 * (src/components/regions/bank-details-editor.tsx) for the add/remove-row
 * mechanics.
 *
 * Deliberately does NOT let the admin type a row's lower bound, or mark any
 * row but the last one "open" — see `toTiers` above for why that keeps a
 * gap or an overlap from ever leaving this form, even though the save path
 * validates the submitted table again regardless (a hand-crafted request
 * bypasses this component entirely).
 */
export function CommissionTiersForm({
  action,
  defaultValue,
}: {
  action: (formData: FormData) => Promise<ActionResult>;
  defaultValue: CommissionTier[];
}) {
  const [rows, setRows] = useState<TierRow[]>(() => rowsFromTiers(defaultValue));
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  function updateRow(id: string, patch: Partial<Pick<TierRow, "upToPct" | "ratePct">>) {
    setRows((prev) => prev.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }

  function removeRow(id: string) {
    setRows((prev) => prev.filter((row) => row.id !== id));
  }

  function addRow() {
    setRows((prev) => (prev.length >= MAX_ROWS ? prev : [...prev, { id: nextRowId(), upToPct: "", ratePct: "" }]));
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData();
    formData.set("value", JSON.stringify(toTiers(rows)));
    setError(null);
    startTransition(async () => {
      const result = await action(formData);
      if (result?.error) {
        setError(result.error);
        toast.error(result.error);
        return;
      }
      toast.success("Saved");
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium text-brand-dark">Commission tiers</span>
        <p className="text-sm text-slate-500">
          The commission rate a salesperson earns, by the quote&apos;s own discount percentage. Each row covers up
          to (and including) the percentage typed, before the next row starts. Clear every row to stop showing a
          commission figure in the builder.
        </p>
      </div>

      {rows.length === 0 ? (
        <p className="text-sm text-slate-500">No commission tiers — the builder won&apos;t show a commission figure.</p>
      ) : null}

      {/* A real two-column grid rather than a flex row per tier. The previous
          layout kept the last row's rate input in line with the others using
          an invisible spacer standing in for the upper-bound field it does
          not have, which is exactly the kind of alignment that comes apart
          the moment anything around it changes — and it did. Here every cell
          sits in a named column, so the "and above" row aligns because it
          occupies the same column, not because something is padding it. */}
      {rows.length > 0 ? (
        <div className={cn(TIER_GRID, "hidden sm:grid")}>
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Discount given</span>
          <span className="text-xs font-semibold uppercase tracking-wide text-brand sm:border-l sm:border-slate-200 sm:pl-3">
            Commission earned
          </span>
          <span aria-hidden="true" />
        </div>
      ) : null}

      {rows.map((row, index) => {
        const isLast = index === rows.length - 1;
        const fromPct = lowerBoundOf(rows, index);
        return (
          <div key={row.id} className={TIER_GRID}>
            <div className="col-start-1 row-start-1 flex items-center gap-2 sm:col-auto sm:row-auto">
              <span className="w-24 shrink-0 text-xs font-semibold uppercase tracking-wide text-slate-500 sm:hidden">
                Discount
              </span>
              {/* The lower bound is derived from the row above, never typed
                  (see `toTiers`), so it reads as text — showing it turns a
                  bare number into the range it actually means. */}
              <span className="shrink-0 text-sm tabular-nums text-slate-500">{fromPct}%</span>
              {isLast ? (
                <span className="text-sm text-slate-500">and above</span>
              ) : (
                <>
                  <span aria-hidden="true" className="text-sm text-slate-400">
                    –
                  </span>
                  <input
                    aria-label={`Tier ${index + 1} upper bound, percent`}
                    type="number"
                    min={0}
                    max={100}
                    step={0.01}
                    value={row.upToPct}
                    onChange={(e) => updateRow(row.id, { upToPct: e.target.value })}
                    disabled={pending}
                    className={cn(fieldInputClass, "w-20 shrink-0 sm:w-full sm:min-w-0")}
                  />
                </>
              )}
            </div>
            <div className="col-start-1 row-start-2 flex items-center gap-2 sm:col-auto sm:row-auto sm:border-l sm:border-slate-200 sm:pl-3">
              <span className="w-24 shrink-0 text-xs font-semibold uppercase tracking-wide text-brand sm:hidden">
                Commission
              </span>
              <input
                aria-label={`Tier ${index + 1} rate, percent`}
                placeholder="Rate %"
                type="number"
                min={0}
                max={100}
                step={0.01}
                value={row.ratePct}
                onChange={(e) => updateRow(row.id, { ratePct: e.target.value })}
                disabled={pending}
                className={cn(fieldInputClass, "w-20 shrink-0 sm:w-full sm:min-w-0")}
              />
            </div>
            {pending ? (
              <span aria-hidden="true" className="hidden sm:block" />
            ) : (
              <Button
                type="button"
                variant="outline"
                onClick={() => removeRow(row.id)}
                className="col-start-2 row-start-1 row-span-2 h-11 w-11 shrink-0 self-center justify-self-end sm:col-auto sm:row-auto sm:row-span-1 sm:self-auto sm:justify-self-auto"
                aria-label={`Remove tier ${index + 1}`}
              >
                <Trash2 className="size-4" aria-hidden="true" />
              </Button>
            )}
          </div>
        );
      })}

      {!pending && rows.length < MAX_ROWS ? (
        <Button type="button" variant="outline" onClick={addRow} className="h-11 w-full sm:w-auto sm:self-start">
          <Plus className="size-4" data-icon="inline-start" aria-hidden="true" />
          Add tier
        </Button>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <Button type="submit" disabled={pending} className="h-11 w-full sm:w-auto sm:self-start" variant="outline">
        {pending ? "Saving…" : "Save"}
      </Button>
    </form>
  );
}
