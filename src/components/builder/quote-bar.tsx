import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import type { DocumentStatus } from "@prisma/client";
import { formatMoney } from "@/lib/format";
import { StatusBadge, STATUS_TONE } from "@/components/ui-kit";
import { BuilderTabs } from "./builder-tabs";
import type { BuilderTab } from "@/lib/builder-tabs";

/**
 * Who this quote is for, what state it is in, what it comes to, and the one
 * action that moves it forward. Sticky, and identical at every width.
 *
 * It replaces two blocks that were rendered twice in the DOM and toggled with
 * `hidden lg:block` / `lg:hidden`, with the totals living only in the desktop
 * copy. That arrangement left a tablet between 768px and 1023px with the
 * single-column layout, the desktop icon rail, and no total anywhere on the
 * screen.
 *
 * Deliberately no save indicator. Every field that autosaves already shows its
 * own `AutosaveIndicator` beside itself, which is where that feedback belongs,
 * and a permanent "Saved" that is true almost all of the time says nothing
 * while taking a slot in the busiest row on the page.
 */
export function QuoteBar({
  companyName,
  number,
  contactName,
  regionName,
  status,
  total,
  currency,
  currencySymbol,
  tabCounts,
  children,
}: {
  companyName: string;
  number: string | null;
  contactName: string | null;
  regionName: string | null;
  status: DocumentStatus;
  /** The document's `total`, unformatted; formatted here so the bar and the
   *  Summary breakdown below it can never round differently. */
  total: string;
  currency: string;
  currencySymbol: string | null;
  tabCounts: Partial<Record<BuilderTab, number>>;
  /** The primary action for the current status. A draft's Finalize lives here
   *  rather than in the rail's action stack, so it is reachable without
   *  scrolling past three machines to find it. */
  children?: React.ReactNode;
}) {
  const meta = [number, contactName, regionName].filter(Boolean) as string[];

  return (
    // Negative margins cancel the <main> padding so the bar spans the content
    // column edge to edge, which is what makes it read as chrome rather than
    // as the first card in the list.
    <div className="sticky top-0 z-20 -mx-4 -mt-6 border-b border-line bg-white md:-mx-6 lg:-mx-8">
      <div className="flex flex-wrap items-center gap-x-4 gap-y-3 px-4 py-3 md:px-6 lg:px-8">
        <div className="min-w-0 flex-1">
          <Link
            href="/quotes"
            className="focus-ring inline-flex items-center gap-1 rounded-(--radius-control) text-xs font-medium text-slate-500 transition-colors duration-(--duration-micro) motion-reduce:transition-none md:hover:text-brand-dark"
          >
            <ChevronLeft className="size-3.5" aria-hidden="true" />
            Quotes
          </Link>
          <h1 className="truncate text-base font-semibold text-brand-dark">{companyName}</h1>
          {meta.length > 0 ? (
            <p className="truncate text-xs text-slate-500">
              {meta.map((part, index) => (
                <span key={part}>
                  {index > 0 ? <span className="px-1.5 text-slate-300">/</span> : null}
                  <span className={index === 0 ? "font-mono" : undefined}>{part}</span>
                </span>
              ))}
            </p>
          ) : null}
        </div>

        <StatusBadge tone={STATUS_TONE[status]}>{status === "DRAFT" ? "Draft" : "Final"}</StatusBadge>

        <div className="text-right">
          <p className="text-[0.625rem] font-semibold tracking-wider text-slate-500 uppercase">
            Total
          </p>
          <p className="text-lg font-semibold tabular-nums text-brand-dark">
            {formatMoney(total, currency, currencySymbol)}
          </p>
        </div>

        {children}
      </div>

      <BuilderTabs counts={tabCounts} />
    </div>
  );
}
