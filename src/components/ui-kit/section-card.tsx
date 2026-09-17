import { cn } from "@/lib/utils";

type SectionCardProps = {
  title?: string;
  description?: string;
  actions?: React.ReactNode;
  /** An optional lucide icon element rendered in a small rounded tile beside
   * the title (pass e.g. `<Truck className="size-5" />`). Purely decorative,
   * so it is marked `aria-hidden` by the tile that wraps it. */
  icon?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
  contentClassName?: string;
  /** "danger" gives the card a destructive-tinted border — used for delete
   * confirmations / danger-zone sections (Task C/D). */
  tone?: "default" | "danger";
};

/**
 * Titled, bordered white card — the base building block for grouping form
 * fields, lists, and settings sections. Flat by design (no shadow); the
 * design direction reserves shadows for overlays only.
 */
export function SectionCard({
  title,
  description,
  actions,
  icon,
  children,
  className,
  contentClassName,
  tone = "default",
}: SectionCardProps) {
  const hasHeader = Boolean(title || description || actions || icon);

  return (
    <section
      className={cn(
        "rounded-xl border bg-white p-4 sm:p-6",
        tone === "danger" ? "border-destructive/30" : "border-slate-200",
        className
      )}
    >
      {hasHeader ? (
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div className="flex min-w-0 items-center gap-3">
            {icon ? (
              <span
                aria-hidden="true"
                className="flex size-9 shrink-0 items-center justify-center rounded-lg border border-slate-200 bg-slate-50 text-brand-dark"
              >
                {icon}
              </span>
            ) : null}
            <div className="min-w-0">
              {title ? <h2 className="text-base font-semibold text-brand-dark">{title}</h2> : null}
              {description ? <p className="mt-0.5 text-sm text-slate-500">{description}</p> : null}
            </div>
          </div>
          {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
        </div>
      ) : null}
      <div className={cn(hasHeader ? "mt-4" : undefined, contentClassName)}>{children}</div>
    </section>
  );
}
