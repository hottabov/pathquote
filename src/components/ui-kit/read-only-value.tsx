import { cn } from "@/lib/utils";

/**
 * How a FINAL document renders a setting that a DRAFT renders as a control.
 *
 * Six components each invented their own shape for this, so a read-only quote
 * looked like six documents stapled together: PriceDisplayToggles collapsed to
 * one sentence, DeliveryTermsField to "Delivered.", ValidityDaysField to
 * "Valid for N days.", NotesSection to prose or "No notes.",
 * TermsDocumentsPanel to a <dl> plus a bullet list, and ClientSection to a
 * bare line of text.
 *
 * With a `label` it renders `<dt>`/`<dd>`, so a group of those belongs
 * inside a `<dl>`. Without one it renders a plain paragraph in the same
 * type: several of these sit alone inside a `SectionCard` that already
 * carries the label as its title, and printing it twice is worse than the
 * inconsistency this component exists to remove.
 */
export function ReadOnlyValue({
  label,
  children,
  empty = "Not set",
  className,
}: {
  label?: string;
  /** The value. `null`, `undefined` or `""` renders `empty` in muted type. */
  children?: React.ReactNode;
  empty?: string;
  className?: string;
}) {
  const isEmpty = children === null || children === undefined || children === "";
  const valueClass = cn("text-sm", isEmpty ? "text-slate-400" : "text-brand-dark");

  if (label === undefined) {
    return <p className={cn(valueClass, className)}>{isEmpty ? empty : children}</p>;
  }

  return (
    <div className={cn("flex flex-col gap-0.5", className)}>
      <dt className="text-xs font-medium tracking-wide text-slate-500 uppercase">{label}</dt>
      <dd className={cn("m-0", valueClass)}>{isEmpty ? empty : children}</dd>
    </div>
  );
}
