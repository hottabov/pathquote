import { cn } from "@/lib/utils";
import {
  Skeleton,
  SkeletonCard,
  SkeletonGroup,
  SkeletonPageHeader,
  SkeletonScreen,
} from "@/components/ui-kit/skeleton";

/**
 * Whole-page loading skeletons, one per page shape. Each route's
 * `loading.tsx` picks the one that matches what it is about to show, so the
 * page doesn't visibly rearrange itself when the real content replaces it.
 *
 * Why there are so many loading.tsx files: Next attaches a folder's
 * loading.tsx to every child route of that folder's layout, and shows it
 * only when that child changes. A folder without one leaves the previous
 * page frozen on screen with no sign anything is happening — the problem
 * these exist to fix. So each level that has pages of its own carries one.
 */

/** Cycled through so a column of placeholders doesn't look ruled. */
const LINE_WIDTHS = ["w-3/4", "w-1/2", "w-2/3", "w-5/12", "w-4/5", "w-7/12"];

function lineWidth(i: number) {
  return LINE_WIDTHS[i % LINE_WIDTHS.length];
}

/* ── Generic ─────────────────────────────────────────────────────────────── */

/**
 * Header plus two cards of rows. The fallback for any screen without a
 * shape of its own — the dashboard, Settings pages, and the brief moment
 * between two nested loading boundaries.
 */
export function PageSkeleton({ label = "Loading" }: { label?: string }) {
  return (
    <SkeletonScreen label={label}>
      <SkeletonPageHeader />
      <SkeletonCard step={1}>
        <div className="flex flex-col divide-y divide-slate-100">
          {Array.from({ length: 4 }, (_, i) => (
            <SkeletonGroup key={i} step={2 + i} className="flex items-center justify-between gap-4 py-3">
              <Skeleton className="h-4 w-1/3" />
              <Skeleton soft className={cn("h-4", i % 2 ? "w-1/4" : "w-1/3")} />
            </SkeletonGroup>
          ))}
        </div>
      </SkeletonCard>
      <SkeletonCard step={4}>
        <FieldGrid count={2} firstStep={5} />
      </SkeletonCard>
    </SkeletonScreen>
  );
}

/* ── Lists ───────────────────────────────────────────────────────────────── */

/**
 * A list page: header with its "New …" button, the search box and result
 * count, then the table on desktop / stacked cards on mobile — the same
 * split `TableShell` makes at `md`.
 */
export function ListPageSkeleton({
  label,
  action = true,
  back = false,
  search = true,
  columns = 5,
  rows = 8,
}: {
  label: string;
  action?: boolean;
  back?: boolean;
  search?: boolean;
  columns?: number;
  rows?: number;
}) {
  return (
    <SkeletonScreen label={label}>
      <SkeletonPageHeader back={back} action={action} />
      {search ? (
        <SkeletonGroup step={1} className="flex flex-col gap-6">
          <Skeleton className="h-11 w-full rounded-lg sm:w-72" />
          <Skeleton soft className="h-4 w-20" />
        </SkeletonGroup>
      ) : null}
      <TableSkeleton columns={columns} rows={rows} firstStep={search ? 2 : 1} />
    </SkeletonScreen>
  );
}

function TableSkeleton({ columns, rows, firstStep }: { columns: number; rows: number; firstStep: number }) {
  const grid = { gridTemplateColumns: `7rem repeat(${Math.max(columns - 1, 1)}, minmax(0, 1fr))` };
  // The column before last is drawn as a status pill: on every list that has
  // one, that is roughly where it sits, and a row of identical bars reads as
  // a spreadsheet rather than this app's tables.
  const pillColumn = columns >= 4 ? columns - 2 : -1;

  return (
    <div>
      {/* The frame is a group of its own, header row included, so it too
          waits out the lead-in instead of flashing up empty on a fast load;
          the rows then fill it one by one. */}
      <SkeletonGroup
        step={firstStep}
        className="hidden overflow-hidden rounded-xl border border-slate-200 bg-white md:block"
      >
        <div className="grid items-center gap-4 border-b border-slate-200 px-4 py-3.5" style={grid}>
          {Array.from({ length: columns }, (_, c) => (
            <Skeleton key={c} soft className="h-3 w-14" />
          ))}
        </div>
        {Array.from({ length: rows }, (_, r) => (
          <SkeletonGroup key={r} step={firstStep + 1 + r}>
            <div
              className="grid items-center gap-4 border-b border-slate-100 px-4 py-3.5 last:border-b-0"
              style={grid}
            >
              <Skeleton className="h-4 w-20" />
              {Array.from({ length: columns - 1 }, (_, c) =>
                c + 1 === pillColumn ? (
                  <Skeleton key={c} soft className="h-5 w-16 rounded-full" />
                ) : (
                  <Skeleton key={c} soft className={cn("h-4", lineWidth(r + c))} />
                )
              )}
            </div>
          </SkeletonGroup>
        ))}
      </SkeletonGroup>

      <div className="flex flex-col gap-3 md:hidden">
        {Array.from({ length: Math.min(rows, 5) }, (_, r) => (
          <SkeletonGroup
            key={r}
            step={firstStep + r}
            className="flex flex-col gap-2.5 rounded-xl border border-slate-200 bg-white p-4"
          >
            <div className="flex items-center justify-between gap-3">
              <Skeleton className="h-4 w-24" />
              <Skeleton soft className="h-5 w-16 rounded-full" />
            </div>
            <Skeleton soft className={cn("h-4", lineWidth(r))} />
            <Skeleton soft className="h-3 w-1/3" />
          </SkeletonGroup>
        ))}
      </div>
    </div>
  );
}

/**
 * The catalog front page: a grid of series cards, each a square image slot
 * beside its name and product count.
 */
export function CardGridSkeleton({ label, cards = 6 }: { label: string; cards?: number }) {
  return (
    <SkeletonScreen label={label}>
      <SkeletonPageHeader />
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {Array.from({ length: cards }, (_, i) => (
          <SkeletonGroup
            key={i}
            step={1 + i}
            className="flex items-center gap-4 rounded-xl border border-slate-200 bg-white p-4"
          >
            <Skeleton className="size-28 shrink-0 rounded-lg sm:size-32" />
            <div className="flex min-w-0 flex-1 flex-col gap-2">
              <Skeleton className={cn("h-4", lineWidth(i))} />
              <Skeleton soft className="h-4 w-1/2" />
            </div>
          </SkeletonGroup>
        ))}
      </div>
    </SkeletonScreen>
  );
}

/* ── Forms ───────────────────────────────────────────────────────────────── */

function FieldGrid({ count, firstStep }: { count: number; firstStep: number }) {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      {Array.from({ length: count }, (_, i) => (
        <SkeletonGroup key={i} step={firstStep + i} className="flex flex-col gap-1.5">
          <Skeleton soft className="h-4 w-24" />
          <Skeleton className="h-11 w-full rounded-lg" />
        </SkeletonGroup>
      ))}
    </div>
  );
}

/**
 * A detail or "new …" page: back link and title, then a card of fields and
 * a second, shorter card below it.
 */
export function FormPageSkeleton({ label, fields = 6 }: { label: string; fields?: number }) {
  return (
    <SkeletonScreen label={label}>
      <SkeletonPageHeader back description={false} titleWidth="w-56" />
      <SkeletonCard step={1} titleWidth="w-24">
        <FieldGrid count={fields} firstStep={2} />
        <SkeletonGroup step={2 + fields} className="mt-6 flex justify-end">
          <Skeleton className="h-11 w-full rounded-lg sm:w-32" />
        </SkeletonGroup>
      </SkeletonCard>
      <SkeletonCard step={3} titleWidth="w-28">
        <div className="flex flex-col gap-3">
          {Array.from({ length: 2 }, (_, i) => (
            <Skeleton key={i} soft className="h-10 w-full rounded-lg" />
          ))}
        </div>
      </SkeletonCard>
    </SkeletonScreen>
  );
}

/* ── Quote builder ───────────────────────────────────────────────────────── */

/**
 * The quote builder. The quote bar runs full bleed exactly as `QuoteBar`
 * does (same negative-margin/`cqw` trick, see quote-bar.tsx), then the
 * two-column grid — sections on the left, the sticky summary on the right,
 * one column below `lg`.
 */
export function BuilderSkeleton() {
  return (
    <SkeletonScreen label="Loading quote" className="pb-4">
      <SkeletonGroup
        step={0}
        className="-mt-6 mx-[calc(50%-50cqw)] border-b border-line bg-white px-[calc(50cqw-50%)]"
      >
        <div className="flex flex-wrap items-end gap-x-4 gap-y-2 px-4 pt-3 md:min-h-16 md:px-6 md:pt-0 lg:px-8">
          <Skeleton className="mb-1 size-9 shrink-0 rounded-lg" />
          <div className="mb-3 flex items-center gap-5">
            <Skeleton className="h-5 w-14" />
            <Skeleton soft className="h-5 w-14" />
            <Skeleton soft className="h-5 w-16" />
          </div>
          <div className="mb-3 ml-auto flex items-center gap-4">
            <Skeleton soft className="h-6 w-14 rounded-full" />
            <div className="flex flex-col items-end gap-1.5">
              <Skeleton soft className="h-3 w-20" />
              <Skeleton className="h-6 w-28" />
            </div>
            <Skeleton className="h-11 w-28 rounded-lg" />
          </div>
        </div>
      </SkeletonGroup>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3 lg:items-start">
        <div className="flex flex-col gap-4 lg:col-span-2">
          <SkeletonCard step={1} icon titleWidth="w-20">
            <FieldGrid count={2} firstStep={2} />
          </SkeletonCard>

          <SkeletonCard step={2} icon titleWidth="w-24">
            <div className="flex flex-col gap-3">
              {Array.from({ length: 3 }, (_, i) => (
                <SkeletonGroup
                  key={i}
                  step={3 + i}
                  className="flex items-center gap-3 rounded-lg border border-slate-100 p-3"
                >
                  <Skeleton className="size-(--size-item-thumb) shrink-0 rounded-lg" />
                  <div className="flex min-w-0 flex-1 flex-col gap-2">
                    <Skeleton className={cn("h-4", lineWidth(i))} />
                    <Skeleton soft className="h-3 w-1/3" />
                  </div>
                  <Skeleton className="hidden h-5 w-20 sm:block" />
                </SkeletonGroup>
              ))}
              <Skeleton soft className="h-11 w-full rounded-lg" />
            </div>
          </SkeletonCard>

          <SkeletonCard step={5} icon titleWidth="w-28">
            <Skeleton soft className="h-10 w-full rounded-lg" />
          </SkeletonCard>
        </div>

        <div className="lg:col-span-1">
          <SkeletonCard step={3} titleWidth="w-24">
            <div className="flex flex-col gap-3">
              {Array.from({ length: 5 }, (_, i) => (
                <div key={i} className="flex items-center justify-between gap-4">
                  <Skeleton soft className={cn("h-4", i === 4 ? "w-1/3" : "w-2/5")} />
                  <Skeleton className={cn(i === 4 ? "h-6 w-24" : "h-4 w-16")} />
                </div>
              ))}
            </div>
          </SkeletonCard>
        </div>
      </div>
    </SkeletonScreen>
  );
}

/* ── Quotation preview ───────────────────────────────────────────────────── */

/**
 * The customer quotation preview: the toolbar card, then an A4-proportioned
 * sheet on the grey well, its letterhead, client block, line table and
 * totals arriving in that order.
 */
export function QuotationSkeleton() {
  return (
    <SkeletonScreen label="Loading quotation" className="mx-auto w-full max-w-4xl gap-4 pb-8">
      <SkeletonGroup
        step={0}
        className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3"
      >
        <div className="flex items-center gap-3">
          <Skeleton soft className="h-4 w-28" />
          <span className="h-4 w-px bg-slate-200" aria-hidden="true" />
          <Skeleton className="h-4 w-28" />
          <Skeleton soft className="h-5 w-14 rounded-full" />
        </div>
        <Skeleton className="h-11 w-full rounded-lg sm:w-56" />
      </SkeletonGroup>

      <SkeletonGroup step={1} className="rounded-xl bg-slate-100 p-4 sm:p-8">
        <div className="mx-auto flex aspect-[210/297] w-full max-w-[794px] flex-col gap-8 bg-white p-[6%] shadow-lg">
          <SkeletonGroup step={1} className="flex items-start justify-between gap-6">
            <Skeleton className="h-10 w-36" />
            <div className="flex flex-col items-end gap-2">
              <Skeleton soft className="h-3 w-40" />
              <Skeleton soft className="h-3 w-32" />
              <Skeleton soft className="h-3 w-36" />
            </div>
          </SkeletonGroup>

          <SkeletonGroup step={2} className="flex flex-col gap-3">
            <Skeleton className="h-6 w-48" />
            <div className="grid grid-cols-2 gap-6">
              {[0, 1].map((col) => (
                <div key={col} className="flex flex-col gap-2">
                  <Skeleton soft className="h-3 w-3/4" />
                  <Skeleton soft className="h-3 w-1/2" />
                  <Skeleton soft className="h-3 w-2/3" />
                </div>
              ))}
            </div>
          </SkeletonGroup>

          <div className="flex flex-col gap-2.5">
            <SkeletonGroup step={3}>
              <Skeleton className="h-7 w-full" />
            </SkeletonGroup>
            {Array.from({ length: 6 }, (_, i) => (
              <SkeletonGroup key={i} step={4 + i} className="flex items-center gap-4">
                <Skeleton soft className={cn("h-4 flex-1", i % 2 ? "max-w-[55%]" : "max-w-[70%]")} />
                <Skeleton soft className="ml-auto h-4 w-16" />
              </SkeletonGroup>
            ))}
          </div>

          <SkeletonGroup step={10} className="ml-auto flex w-48 flex-col gap-2">
            <Skeleton soft className="h-4 w-full" />
            <Skeleton soft className="h-4 w-full" />
            <Skeleton className="h-6 w-full" />
          </SkeletonGroup>
        </div>
      </SkeletonGroup>
    </SkeletonScreen>
  );
}
