"use client";

import { useState, useTransition, type FormEvent } from "react";
import { Plus, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { fieldInputClass } from "@/components/ui-kit";
import { useToast } from "@/components/ui-kit/client";
import { cn } from "@/lib/utils";
import { DEFAULT_COMMISSION_TIERS, type CommissionTier } from "@/lib/pricing";
import {
  flatRateRows,
  rowEndLabel,
  rowsFromTiers,
  tiersFromRows,
  type TierRowInput,
} from "@/lib/commission-tiers-editor";

const MAX_ROWS = 12;

/** Discount range | commission | remove, shared by the header and every row
 * so the columns line up by construction. On a phone the range sits above
 * the rate on the left and the remove button spans both on the right. */
const TIER_GRID =
  "grid grid-cols-[minmax(0,1fr)_2.75rem] grid-rows-[auto_auto] items-center gap-x-3 gap-y-1.5 sm:grid-cols-[minmax(0,3fr)_minmax(0,2fr)_2.75rem] sm:grid-rows-none sm:gap-3";

type Row = TierRowInput & { id: string };

let rowCounter = 0;
function withIds(rows: TierRowInput[]): Row[] {
  return rows.map((row) => {
    rowCounter += 1;
    return { ...row, id: `commission-tier-row-${rowCounter}` };
  });
}

/**
 * One user's commission table, in Settings → Users → <user> → Commission
 * (admin and developer only — the page and `setUserCommissionTiers` both
 * check). The rows are the rate this user earns on their own quotes, by the
 * quote's own discount; the engine reads the AUTHOR's table
 * (`User.commissionTiers`).
 *
 * The admin types where each row starts and its rate; where it ends is shown,
 * never typed (see src/lib/commission-tiers-editor.ts for why that makes a
 * gap impossible). Two presets cover the common shapes — "Flat rate" (one
 * row, every discount) and "Standard tiers" (the owner's banded table) — and
 * removing every row means no commission at all, which is what a distributor
 * gets. A single explicit Save, like the rest of the settings forms.
 */
export function CommissionTiersForm({
  action,
  defaultValue,
}: {
  action: (formData: FormData) => Promise<{ error?: string }>;
  defaultValue: CommissionTier[];
}) {
  const [rows, setRows] = useState<Row[]>(() => withIds(rowsFromTiers(defaultValue)));
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const toast = useToast();

  function updateRow(id: string, patch: Partial<TierRowInput>) {
    setRows((prev) => prev.map((row) => (row.id === id ? { ...row, ...patch } : row)));
  }

  function removeRow(id: string) {
    setRows((prev) => prev.filter((row) => row.id !== id));
  }

  function addRow() {
    setRows((prev) => (prev.length >= MAX_ROWS ? prev : [...prev, ...withIds([{ fromPct: "", ratePct: "" }])]));
  }

  function applyFlatRate() {
    // Keeps the rate the first row already had, so switching a banded user to
    // a flat rate starts from a number rather than an empty field.
    setRows((prev) => withIds(flatRateRows(prev[0]?.ratePct ?? "")));
    setError(null);
  }

  function applyStandardTiers() {
    setRows(withIds(rowsFromTiers(DEFAULT_COMMISSION_TIERS)));
    setError(null);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const result = tiersFromRows(rows);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    const formData = new FormData();
    formData.set("value", JSON.stringify(result.tiers));
    setError(null);
    startTransition(async () => {
      const saved = await action(formData);
      if (saved?.error) {
        setError(saved.error);
        toast.error(saved.error);
        return;
      }
      toast.success("Commission saved");
    });
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-3">
      <p className="text-sm text-slate-500">
        Each row is a range of the quote&apos;s discount and the commission it earns. Type where a row starts; it runs
        up to just before the next one, and the last row covers everything above. The first row always starts at 0%,
        so a quote at full price is always covered. One row pays the same rate whatever the discount. No rows means
        no commission, and the builder shows none.
      </p>

      <div className="flex flex-wrap gap-2">
        <Button type="button" variant="outline" onClick={applyFlatRate} disabled={pending} className="h-11">
          Flat rate
        </Button>
        <Button type="button" variant="outline" onClick={applyStandardTiers} disabled={pending} className="h-11">
          Standard tiers
        </Button>
      </div>

      {rows.length === 0 ? (
        <p className="rounded-lg border border-dashed border-slate-200 px-3 py-3 text-sm text-slate-500">
          No commission — this user earns none, and the quote builder shows no commission line.
        </p>
      ) : (
        <div className={cn(TIER_GRID, "hidden sm:grid")}>
          <span className="text-xs font-semibold uppercase tracking-wide text-slate-500">Discount given</span>
          <span className="text-xs font-semibold uppercase tracking-wide text-brand sm:border-l sm:border-slate-200 sm:pl-3">
            Commission earned
          </span>
          <span aria-hidden="true" />
        </div>
      )}

      {rows.map((row, index) => {
        const isFirst = index === 0;
        const end = rowEndLabel(rows, index);
        return (
          <div key={row.id} className={TIER_GRID}>
            <div className="col-start-1 row-start-1 flex items-center gap-2 sm:col-auto sm:row-auto">
              <span className="w-24 shrink-0 text-xs font-semibold uppercase tracking-wide text-slate-500 sm:hidden">
                Discount
              </span>
              {isFirst ? (
                // Fixed, not typed: the table has to cover a quote at full
                // price, so its first row always starts at 0%.
                <span className="w-20 shrink-0 text-right text-sm tabular-nums text-slate-700">0%</span>
              ) : (
                <span className="flex w-20 shrink-0 items-center gap-1">
                  <input
                    aria-label={`Row ${index + 1}: discount from, percent`}
                    type="number"
                    inputMode="decimal"
                    min={0.01}
                    max={100}
                    step={0.01}
                    placeholder="from"
                    value={row.fromPct}
                    onChange={(e) => updateRow(row.id, { fromPct: e.target.value })}
                    disabled={pending}
                    className={cn(fieldInputClass, "w-full min-w-0 text-right")}
                  />
                  <span className="text-sm text-slate-500">%</span>
                </span>
              )}
              <span className="text-sm text-slate-500">
                {end === "and above" ? "and above" : end ? `to ${end}` : "to …"}
              </span>
            </div>
            <div className="col-start-1 row-start-2 flex items-center gap-2 sm:col-auto sm:row-auto sm:border-l sm:border-slate-200 sm:pl-3">
              <span className="w-24 shrink-0 text-xs font-semibold uppercase tracking-wide text-brand sm:hidden">
                Commission
              </span>
              <span className="flex w-24 shrink-0 items-center gap-1">
                <input
                  aria-label={`Row ${index + 1}: commission rate, percent`}
                  type="number"
                  inputMode="decimal"
                  min={0}
                  max={100}
                  step={0.01}
                  placeholder="rate"
                  value={row.ratePct}
                  onChange={(e) => updateRow(row.id, { ratePct: e.target.value })}
                  disabled={pending}
                  className={cn(fieldInputClass, "w-full min-w-0 text-right")}
                />
                <span className="text-sm text-slate-500">%</span>
              </span>
            </div>
            <Button
              type="button"
              variant="outline"
              onClick={() => removeRow(row.id)}
              disabled={pending}
              className="col-start-2 row-start-1 row-span-2 h-11 w-11 shrink-0 self-center justify-self-end sm:col-auto sm:row-auto sm:row-span-1 sm:self-auto sm:justify-self-auto"
              aria-label={`Remove row ${index + 1}`}
            >
              <Trash2 className="size-4" aria-hidden="true" />
            </Button>
          </div>
        );
      })}

      {rows.length < MAX_ROWS ? (
        <Button
          type="button"
          variant="outline"
          onClick={addRow}
          disabled={pending}
          className="h-11 w-full sm:w-auto sm:self-start"
        >
          <Plus className="size-4" data-icon="inline-start" aria-hidden="true" />
          Add row
        </Button>
      ) : null}

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      <Button type="submit" disabled={pending} className="h-11 w-full sm:w-auto sm:self-start">
        {pending ? "Saving…" : "Save commission"}
      </Button>
    </form>
  );
}
