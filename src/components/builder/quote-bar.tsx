import Link from "next/link";
import { ChevronLeft } from "lucide-react";
import type { DocumentStatus } from "@prisma/client";
import { formatMoney } from "@/lib/format";
import { StatusBadge, STATUS_TONE } from "@/components/ui-kit";
import { Tooltip } from "@/components/ui-kit/client";
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
  number,
  status,
  total,
  currency,
  currencySymbol,
  tabs,
  tabCounts,
  children,
}: {
  number: string | null;
  status: DocumentStatus;
  /** The document's `total`, unformatted; formatted here so the bar and the
   *  Summary breakdown below it can never round differently. */
  total: string;
  currency: string;
  currencySymbol: string | null;
  /** Which tabs this quote has, in order -- see `builderTabsFor`. */
  tabs: BuilderTab[];
  tabCounts: Partial<Record<BuilderTab, number>>;
  /** The primary action for the current status. A draft's Finalize lives here
   *  rather than in the rail's action stack, so it is reachable without
   *  scrolling past three machines to find it. */
  children?: React.ReactNode;
}) {
  return (
    // Full bleed. `mx-[calc(50%-50cqw)]` widens this to the full width of
    // the app's content region and the matching padding puts its contents
    // back on the content column's grid, so the white and the hairline
    // under the tabs run edge to edge while the text still lines up with
    // the cards below.
    //
    // `cqw`, not `vw`. `vw` measures the window, which is wider than this
    // region by the width of the sidebar, so the bar overhung the right
    // edge by half a sidebar. Nothing showed it while the root refused to
    // scroll horizontally -- and then a confirm dialog's scroll lock made
    // the root scrollable for a moment, the page slid sideways by exactly
    // that much, and stayed there. The container is declared on the content
    // region in app-shell.tsx.
    <div className="sticky top-0 z-20 -mt-6 mx-[calc(50%-50cqw)] border-b border-line bg-white px-[calc(50cqw-50%)]">
      {/* One row. The company, the contact and the region used to sit above
          this in a block of their own, and all three are already on screen
          in the Client card below -- the quote bar was repeating them at the
          top of every tab to fill a line. What is left is what only this bar
          can say: where this quote stands, what it comes to, and the one
          action that moves it on. */}
      {/* md+: 64px tall, the same as the sidebar's wordmark block, so this
          bar's hairline and the one under the wordmark are a single line
          across the window rather than two rules a few pixels apart. `min-h`
          and not `h`, because this row wraps at narrow desktop widths and a
          fixed height would crop the wrapped line; when it wraps the two
          hairlines part company, which is the lesser of the two. Below md
          the sidebar is off screen, so there is nothing to line up with. */}
      <div className="flex flex-wrap items-end gap-x-4 gap-y-2 px-4 pt-3 md:min-h-16 md:px-6 md:pt-0 lg:px-8">
        {/* The way out, on the tab row rather than above the company name.
            As a text link it took a line of its own at the top of the
            busiest block on the page to say one word; as an icon beside the
            tabs it costs nothing and sits where the eye already goes to
            change view. The label lives in the tooltip and the aria-label,
            not in the row. */}
        <Tooltip label="All quotes">
          <Link
            href="/quotes"
            aria-label="All quotes"
            className="focus-ring mb-1 flex size-9 shrink-0 items-center justify-center rounded-(--radius-control) text-slate-500 transition-colors duration-(--duration-micro) ease-out-soft motion-reduce:transition-none md:hover:bg-slate-100 md:hover:text-brand-dark"
          >
            <ChevronLeft className="size-4" aria-hidden="true" />
          </Link>
        </Tooltip>

        <BuilderTabs tabs={tabs} counts={tabCounts} />

        <div className="mb-3 ml-auto flex items-center gap-4">
          <StatusBadge tone={STATUS_TONE[status]}>{status === "DRAFT" ? "Draft" : "Final"}</StatusBadge>

          <div className="text-right">
            {/* The quote's number, where the word "TOTAL" used to be. The
                figure under it is obviously a total; its number is the one
                thing about a quote you have to quote back to someone, and
                it had been demoted to a slash-separated crumb. */}
            <p className="font-mono text-[0.6875rem] text-slate-500">{number ?? "New quote"}</p>
            <p className="text-lg font-semibold tabular-nums text-brand-dark">
              {formatMoney(total, currency, currencySymbol)}
            </p>
          </div>

          {children}
        </div>
      </div>
    </div>
  );
}
