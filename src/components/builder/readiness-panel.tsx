"use client";

import Link from "next/link";
import { Check, CircleAlert, Info } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ReadinessRow } from "@/lib/quote-readiness";

/**
 * What is still missing, unusual or incompatible -- shown before Finalize is
 * pressed rather than after.
 *
 * Only rows that ask for attention are drawn, and the caller drops the whole
 * card when none do (see `readinessNeedsAttention`). A finished quote used
 * to show five green ticks at the top of the narrowest column to report that
 * there was nothing to do; the Finalize button going live says that, and it
 * says it where the decision is made.
 *
 * `FinalizeButton` reported its blockers only once it had been pressed and
 * refused, which made "why can I not finalize this" the last question the
 * screen answered instead of the first. The rows come from `quoteReadiness`,
 * the same function the button's own disabled state is derived from, so this
 * panel cannot claim a quote is ready while the action would refuse it.
 *
 * Revealing a machine goes through a `CustomEvent` rather than lifting the
 * item list's expansion state up to the page. The list owns which machines
 * are open, nothing above it needs to know, and an event keeps that boundary
 * where it is instead of threading a setter through three components.
 */
export function ReadinessPanel({ rows }: { rows: ReadinessRow[] }) {
  const blocking = rows.filter((row) => row.blocking);
  const met = blocking.filter((row) => row.met).length;
  const total = blocking.length;
  const shown = rows.filter((row) => row.needsAttention);
  // The meter measures the road to Finalize, so it belongs on screen only
  // while something is still in the way. Beside a lone advisory remark it
  // would read "3 of 3" under a warning, which is a contradiction.
  const blocked = met < total;

  if (shown.length === 0) return null;

  return (
    <div>
      {blocked ? (
      <div
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={total}
        aria-valuenow={met}
        aria-label={`${met} of ${total} requirements met`}
        className="mb-3 h-1.5 overflow-hidden rounded-(--radius-pill) bg-slate-200"
      >
        <div
          className="h-full rounded-(--radius-pill) bg-emerald-700 transition-[width] duration-(--duration-overlay) ease-(--ease-move) motion-reduce:transition-none"
          style={{ width: total > 0 ? `${(met / total) * 100}%` : "0%" }}
        />
      </div>
      ) : null}

      <ul className="flex flex-col">
        {shown.map((row) => (
          <li key={row.key} className="flex items-start gap-2.5 border-b border-divider py-2 last:border-b-0">
            <RowIcon met={row.met} blocking={row.blocking} />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium text-brand-dark">{row.label}</p>
              {row.detail ? <p className="text-xs text-slate-500">{row.detail}</p> : null}
              {!row.met && row.blocking ? <Reveal row={row} /> : null}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}

function RowIcon({ met, blocking }: { met: boolean; blocking: boolean }) {
  // An unmet advisory row is neither a tick nor a warning: it is a fact the
  // reader may want to act on, and dressing it in amber would put it on the
  // same footing as something that actually stops the quote.
  const tone = met ? "met" : blocking ? "blocking" : "info";
  const Icon = tone === "met" ? Check : tone === "blocking" ? CircleAlert : Info;
  return (
    <span
      aria-hidden="true"
      className={cn(
        "mt-0.5 flex size-[1.125rem] shrink-0 items-center justify-center rounded-full",
        tone === "met" && "bg-emerald-50 text-emerald-700",
        tone === "blocking" && "bg-amber-50 text-amber-700",
        tone === "info" && "bg-slate-100 text-slate-500"
      )}
    >
      <Icon className="size-3" />
    </span>
  );
}

function Reveal({ row }: { row: ReadinessRow }) {
  const className =
    "focus-ring mt-0.5 inline-block rounded text-xs font-semibold text-brand md:hover:underline";

  if (row.targetItemId) {
    return (
      <button
        type="button"
        className={className}
        onClick={() =>
          window.dispatchEvent(
            new CustomEvent("builder:reveal-item", { detail: { itemId: row.targetItemId } })
          )
        }
      >
        Go and fill it in
      </button>
    );
  }
  return (
    <Link href={row.targetTab === "build" ? "?" : `?tab=${row.targetTab}`} scroll={false} className={className}>
      {row.targetTab === "terms" ? "Open Quote terms" : "Open Build"}
    </Link>
  );
}
