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
    // Full bleed. `mx-[calc(50%-50vw)]` widens this to the viewport and the
    // matching padding puts its contents back on the content column's grid,
    // so the white and the hairline under the tabs run edge to edge while
    // the text still lines up with the cards below. The overflow that
    // creates is contained by `overflow-x-clip` on <main>.
    <div className="sticky top-0 z-20 -mt-6 mx-[calc(50%-50vw)] bg-white px-[calc(50vw-50%)]">
      <div className="px-4 pt-3 md:px-6 lg:px-8">
        <div className="flex flex-wrap items-start gap-x-4 gap-y-3">
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

          <div className="flex items-center gap-4">
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
        </div>
      </div>

      {/* The gap between the identity block and the tabs is the point: they
          are two different things, and touching they read as one crowded
          block. The hairline under them belongs to the tab row itself, not to
          this wrapper: on the wrapper the open tab's -mb-px could not reach
          it, so the line ran straight under the open tab instead of around
          it. */}
      <div className="mt-4">
        <BuilderTabs counts={tabCounts} />
      </div>
    </div>
  );
}
