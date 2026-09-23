"use client";

import Link from "next/link";
import { Info, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ReadinessRow } from "@/lib/quote-readiness";

/**
 * What is still missing, unusual or incompatible -- said before Finalize is
 * pressed rather than after.
 *
 * It had a card of its own and does not any more. It lives at the top of
 * Summary, beside the over-the-cap message, which was already the one place
 * this quote told the reader something was wrong -- two places saying that,
 * in two visual languages, one of them a progress meter, was one too many.
 * Only rows that ask for attention are drawn, and on a quote with nothing to
 * report this renders nothing at all: the Finalize button going live says
 * the rest, where the decision is made.
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
  const shown = rows.filter((row) => row.needsAttention);
  if (shown.length === 0) return null;

  return (
    <ul className="flex flex-col gap-2">
      {shown.map((row) => {
        // A row that actually stops Finalize is amber, the same warning
        // colour the over-the-cap message beside it uses. An advisory one
        // is neither a warning nor a tick: it is a fact the reader may want
        // to act on, and dressing it in amber would put "no legal documents
        // will print" on the same footing as "this quote cannot be
        // finalised".
        const stops = row.blocking && !row.met;
        const Icon = stops ? TriangleAlert : Info;
        return (
          <li
            key={row.key}
            className={cn(
              "flex items-start gap-2 rounded-lg border px-3 py-2 text-xs",
              stops
                ? "border-amber-300 bg-amber-50 text-amber-800"
                : "border-line bg-slate-50 text-slate-600"
            )}
          >
            <Icon className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
            <div className="min-w-0 flex-1">
              <p className="font-medium">{row.label}</p>
              {row.detail ? <p className="mt-0.5">{row.detail}</p> : null}
              {stops ? <Reveal row={row} /> : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function Reveal({ row }: { row: ReadinessRow }) {
  const className =
    "focus-ring mt-1 inline-block rounded text-xs font-semibold underline-offset-2 md:hover:underline";

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
      {row.targetTab === "settings" ? "Open Quote setup" : "Open Build"}
    </Link>
  );
}
