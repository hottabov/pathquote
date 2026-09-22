import type { LucideIcon } from "lucide-react";
import { cn } from "@/lib/utils";

type EmptyStateProps = {
  icon: LucideIcon;
  title: string;
  description?: string;
  action?: React.ReactNode;
  /** The dashed outline. On by default, because most of these sit directly
   * on the page background and need an edge to read as a placeholder. Turn
   * it off when this is the sole content of a bordered card, where it would
   * otherwise draw a dashed border a few pixels inside a solid one. */
  bordered?: boolean;
  /** Halves the vertical padding and shrinks the icon. For a placeholder
   * inside a panel or a scrolling list, where the full-height version
   * pushes everything else out of view to say that nothing is there. */
  compact?: boolean;
  className?: string;
};

/** Centered icon + message (+ optional action) shown in place of an empty
 * list/table — used whenever a search/filter or an unpopulated section has
 * nothing to render. */
export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
  bordered = true,
  compact = false,
  className,
}: EmptyStateProps) {
  return (
    <div
      className={cn(
        "flex flex-col items-center gap-3 rounded-xl bg-white px-6 text-center",
        bordered && "border border-dashed border-slate-200",
        compact ? "py-6" : "py-12",
        className
      )}
    >
      <div
        className={cn(
          "flex items-center justify-center rounded-full bg-slate-100",
          compact ? "size-9" : "size-12"
        )}
      >
        <Icon className={cn("text-slate-400", compact ? "size-4" : "size-6")} aria-hidden="true" />
      </div>
      <div>
        <p className="font-medium text-brand-dark">{title}</p>
        {description ? <p className="mt-1 text-sm text-slate-500">{description}</p> : null}
      </div>
      {action ? <div className="mt-1">{action}</div> : null}
    </div>
  );
}
