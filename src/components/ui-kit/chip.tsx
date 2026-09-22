import { cn } from "@/lib/utils";

/**
 * A neutral fact about something, not a state it is in: an option's name on a
 * collapsed machine, the filter currently applied to a list. `StatusBadge` is
 * the one that carries semantic colour (DRAFT, SIGNED, price required); a
 * Chip never does, which is what keeps colour meaningful on a screen that has
 * a lot of both.
 *
 * The builder had four parallel implementations of this exact shape, differing
 * only in padding: the options chips at py-1, the item meta pill at px-2, the
 * disclosure count badge, and the inline status pills in the two editors.
 */
export function Chip({
  children,
  trailing,
  className,
}: {
  children: React.ReactNode;
  /** A figure belonging to the chip's subject, e.g. an option's price. */
  trailing?: React.ReactNode;
  className?: string;
}) {
  return (
    <span
      className={cn(
        "inline-flex h-6 items-center gap-1.5 rounded-(--radius-pill) bg-slate-100 px-2.5 text-xs font-medium whitespace-nowrap text-slate-600",
        className
      )}
    >
      {children}
      {trailing ? <span className="tabular-nums text-slate-500">{trailing}</span> : null}
    </span>
  );
}

/** A count sitting beside a label: a tab's item count, a disclosure's option
 *  count. `tone="brand"` for a count the user is meant to act on. */
export function CountBadge({
  children,
  tone = "neutral",
}: {
  children: React.ReactNode;
  tone?: "neutral" | "brand";
}) {
  return (
    <span
      className={cn(
        "inline-flex h-[1.125rem] min-w-[1.125rem] items-center justify-center rounded-(--radius-pill) px-1.5 text-[0.6875rem] font-semibold tabular-nums",
        tone === "brand" ? "bg-brand/10 text-brand" : "bg-slate-100 text-slate-600"
      )}
    >
      {children}
    </span>
  );
}
