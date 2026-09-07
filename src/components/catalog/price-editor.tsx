"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { fieldInputClass, StatusBadge } from "@/components/ui-kit";
import { cn } from "@/lib/utils";
import type { ActionResult, PriceTarget } from "@/lib/actions/catalog";

export type PriceRowData = {
  regionCode: string;
  regionName: string;
  currency: string;
  amount: string | null;
  needsReview: boolean;
};

const initialState: ActionResult = {};

function PriceRow({
  target,
  row,
  action,
  readOnly,
}: {
  target: PriceTarget;
  row: PriceRowData;
  action: (target: PriceTarget, formData: FormData) => Promise<ActionResult>;
  readOnly: boolean;
}) {
  const [state, formAction, pending] = useActionState(
    (_prevState: ActionResult, formData: FormData) => action(target, formData),
    initialState
  );

  return (
    <form
      action={formAction}
      className="flex w-full min-w-0 flex-col gap-1.5 border-b border-slate-100 py-3 last:border-b-0"
    >
      <input type="hidden" name="regionCode" value={row.regionCode} />
      <div className="flex w-full min-w-0 items-center gap-3">
        <div className="flex min-w-0 flex-1 items-baseline gap-1.5">
          <span className="truncate text-sm font-medium text-brand-dark">{row.regionCode}</span>
          <span className="shrink-0 text-xs text-slate-500">{row.currency}</span>
        </div>
        <input
          name="amount"
          type="text"
          inputMode="decimal"
          aria-label={`${row.regionName} price`}
          placeholder="e.g. 175000"
          defaultValue={row.amount ?? ""}
          disabled={readOnly}
          className={cn(fieldInputClass, "max-w-40 flex-1 text-right tabular-nums")}
        />
        {!readOnly && (
          <Button
            type="submit"
            variant="outline"
            className="h-11 shrink-0 sm:h-9"
            disabled={pending}
          >
            {pending ? "Saving…" : "Save"}
          </Button>
        )}
      </div>
      {row.needsReview ? (
        <StatusBadge tone="amber" className="w-fit shrink-0 self-start whitespace-nowrap">
          Price required
        </StatusBadge>
      ) : null}
      {state.error ? (
        <p role="alert" className="text-sm text-destructive">
          {state.error}
        </p>
      ) : null}
    </form>
  );
}

/**
 * One row per region the viewer may see — every active region for an admin,
 * and only their own for a manager (see `regionsForPriceRows` in
 * src/lib/queries/catalog.ts, which decides that before the rows get here).
 * Each row is an independently-submittable form bound to `upsertPrice` for
 * the given target (a product or an option). Empty amount clears the price;
 * anything else upserts it and clears needsReview. Read-only for non-admins
 * (Managers can view but not edit). Amounts are right-aligned with tabular
 * figures per the design direction's numeric-column convention.
 */
export function PriceEditor({
  target,
  rows,
  action,
  readOnly = false,
}: {
  target: PriceTarget;
  rows: PriceRowData[];
  action: (target: PriceTarget, formData: FormData) => Promise<ActionResult>;
  readOnly?: boolean;
}) {
  // No rows is reachable now that the list is scoped to the viewer: a
  // manager whose region has been deactivated, or a session pointing at a
  // region that no longer exists. Both are correct and fail-closed, but a
  // blank card under a "Prices by region" heading reads as a bug rather
  // than as an answer, so say which it is.
  if (rows.length === 0) {
    return <p className="text-sm text-slate-500">No price is available for your region.</p>;
  }

  return (
    <div>
      {rows.map((row) => (
        <PriceRow key={row.regionCode} target={target} row={row} action={action} readOnly={readOnly} />
      ))}
    </div>
  );
}
