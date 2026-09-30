import { Info, TriangleAlert } from "lucide-react";
import { cn } from "@/lib/utils";
import type { ReadinessRow } from "@/lib/quote-readiness";

/**
 * What is still missing, unusual or incompatible -- said before Finalize is
 * pressed rather than after.
 *
 * It had a card of its own and does not any more. It lives at the top of
 * Summary, the one place this quote tells the reader something is wrong --
 * the over-the-cap message included, which used to be a separate badge
 * beside it. Two places saying that, in two visual languages, was one too
 * many.
 * Only rows that ask for attention are drawn, and on a quote with nothing to
 * report this renders nothing at all: the Finalize button going live says
 * the rest, where the decision is made.
 *
 * `FinalizeButton` reported its blockers only once it had been pressed and
 * refused, which made "why can I not finalize this" the last question the
 * screen answered instead of the first. The rows come from `quoteReadiness`,
 * the same function the button's own disabled state is derived from, so this
 * panel cannot claim a quote is ready while the action would refuse it --
 * the region caps and per-item discount limits included, which are rows too.
 *
 * Messages only, no links. The rows used to carry "Open Build" / "Go and
 * fill it in", but they landed on the tab rather than the thing to fix (the
 * reveal event had no listener at all), so a link that went nowhere useful
 * was worse than none. Each row's detail names the item or setting instead.
 */
export function ReadinessPanel({ rows }: { rows: ReadinessRow[] }) {
  const shown = rows.filter((row) => row.needsAttention);
  if (shown.length === 0) return null;

  return (
    <ul className="flex flex-col gap-2">
      {shown.map((row) => {
        // A row that actually stops Finalize is amber, the app's warning
        // colour. An advisory one
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
            </div>
          </li>
        );
      })}
    </ul>
  );
}
