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
 * Renders `<dt>`/`<dd>`, so a group of these belongs inside a `<dl>`.
 */
export function ReadOnlyValue({
  label,
  children,
  empty = "Not set",
  className,
}: {
  label: string;
  /** The value. `null`, `undefined` or `""` renders `empty` in muted type. */
  children?: React.ReactNode;
  empty?: string;
  className?: string;
}) {
  const isEmpty = children === null || children === undefined || children === "";
  return (
    <div className={cn("flex flex-col gap-0.5", className)}>
      <dt className="text-xs font-medium tracking-wide text-slate-500 uppercase">{label}</dt>
      <dd className={cn("m-0 text-sm", isEmpty ? "text-slate-400" : "text-brand-dark")}>
        {isEmpty ? empty : children}
      </dd>
    </div>
  );
}
