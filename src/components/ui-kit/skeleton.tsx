import type { CSSProperties } from "react";
import { cn } from "@/lib/utils";

/**
 * Building blocks for the loading skeletons every `loading.tsx` draws. The
 * motion lives in globals.css (search "Loading skeletons"): groups fade up
 * one after another, and a band of light sweeps across each block while the
 * page's data is in flight. Server-safe — no hooks, no JavaScript at all.
 *
 * Page-shaped compositions built from these (list, form, builder, …) are in
 * src/components/page-skeletons.tsx.
 */

type StepStyle = CSSProperties & { "--skeleton-step"?: number };

/** Steps past this arrive together, so a long list never takes more than
 * about 0.8s to finish drawing itself. */
const MAX_STEP = 10;

function stepStyle(step: number): StepStyle {
  return { "--skeleton-step": Math.min(Math.max(step, 0), MAX_STEP) };
}

/**
 * One placeholder block. Size and shape it with ordinary utilities (`h-4
 * w-32`, `rounded-full`, …); `soft` is the lighter tone for secondary lines
 * such as descriptions and table cells.
 */
export function Skeleton({ className, soft = false }: { className?: string; soft?: boolean }) {
  return <div aria-hidden="true" className={cn("skeleton", soft && "skeleton-soft", className)} />;
}

/**
 * A set of blocks that arrives together, `step` places along the page's
 * sequence. The step also offsets the shimmer of every block inside, which
 * is what makes the light travel down the page instead of flashing at once.
 */
export function SkeletonGroup({
  step,
  className,
  children,
}: {
  step: number;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div className={cn("skeleton-reveal", className)} style={stepStyle(step)}>
      {children}
    </div>
  );
}

/**
 * The outer wrapper of a whole loading screen: announces the wait to screen
 * readers once (the blocks themselves are hidden from them), and adds the
 * reassurance line that only fades in if the wait runs past a few seconds.
 */
export function SkeletonScreen({
  label,
  className,
  children,
}: {
  /** Read out by screen readers, e.g. "Loading quotes". */
  label: string;
  className?: string;
  children: React.ReactNode;
}) {
  return (
    <div role="status" aria-busy="true" className={cn("flex flex-col gap-6", className)}>
      <span className="sr-only">{label}…</span>
      {children}
      <p
        aria-hidden="true"
        className="skeleton-hint flex items-center justify-center gap-2 text-sm text-slate-500"
      >
        <span className="size-1.5 rounded-full bg-brand-accent" />
        Still loading — this can take a few seconds.
      </p>
    </div>
  );
}

/**
 * Same box as `SectionCard`, with a placeholder where its title (and,
 * optionally, its icon tile) would be. `step` is the card's place in the
 * sequence; pass the card's contents as children.
 */
export function SkeletonCard({
  step,
  icon = false,
  titleWidth = "w-32",
  className,
  children,
}: {
  step: number;
  icon?: boolean;
  titleWidth?: string;
  className?: string;
  children?: React.ReactNode;
}) {
  return (
    <SkeletonGroup step={step} className={cn("rounded-xl border border-slate-200 bg-white p-4 sm:p-6", className)}>
      <div className="flex items-center gap-3">
        {icon ? <Skeleton className="size-9 shrink-0 rounded-lg" /> : null}
        <Skeleton className={cn("h-5", titleWidth)} />
      </div>
      {children ? <div className="mt-4">{children}</div> : null}
    </SkeletonGroup>
  );
}

/** Placeholder for `PageHeader`: optional back link, title, description, action button. */
export function SkeletonPageHeader({
  step = 0,
  back = false,
  description = true,
  action = false,
  titleWidth = "w-48",
}: {
  step?: number;
  back?: boolean;
  description?: boolean;
  action?: boolean;
  titleWidth?: string;
}) {
  return (
    <SkeletonGroup step={step} className="flex flex-col gap-3">
      {back ? <Skeleton soft className="h-4 w-16" /> : null}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-col gap-2">
          <Skeleton className={cn("h-7 max-w-full", titleWidth)} />
          {description ? <Skeleton soft className="h-4 w-64 max-w-full" /> : null}
        </div>
        {action ? <Skeleton className="h-11 w-full rounded-lg sm:w-36" /> : null}
      </div>
    </SkeletonGroup>
  );
}
