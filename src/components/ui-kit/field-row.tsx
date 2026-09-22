import { cloneElement, isValidElement } from "react";
import { cn } from "@/lib/utils";

/**
 * Shared classes for a raw `<input>`/`<select>`/`<textarea>` styled per the
 * design direction: 44px tall (touch target), 16px text (no iOS zoom-on-
 * focus), brand focus ring. Exported so screens that need a bare input
 * outside a `<FieldRow>` (e.g. a search box in a `PageHeader`) stay visually
 * consistent without duplicating the class list.
 */
export const fieldInputClass =
  "h-(--size-control) w-full rounded-(--radius-control) border border-line bg-white px-3 text-base text-brand-dark outline-none transition-colors duration-(--duration-micro) motion-reduce:transition-none placeholder:text-slate-500 focus-visible:border-brand focus-visible:ring-2 focus-visible:ring-brand disabled:cursor-not-allowed disabled:bg-slate-50 disabled:opacity-60";

type FieldRowProps = {
  label: string;
  htmlFor: string;
  error?: string;
  hint?: string;
  required?: boolean;
  className?: string;
  /**
   * "stacked" (the default) puts the label above the control, which is right
   * for a form the user reads top to bottom. "inline" puts it to the left
   * from `sm` up, for a dense settings list where the labels are short and
   * the eye is scanning a column of values rather than filling a form.
   *
   * The inline variant replaces three separate hand-rolled implementations:
   * production-spec-editor's own `CompactField` (a `w-44` label), the terms
   * panel's `sm:grid-cols-[8rem_1fr]` grid, and the label-wraps-input rows in
   * the two discount fields.
   */
  layout?: "stacked" | "inline";
  children: React.ReactNode;
};

/**
 * Consistent label + control + error/hint row for forms. Doesn't render the
 * control itself (pass it as `children`, typically a plain `<input>` using
 * `fieldInputClass`) so it works for inputs, selects, and textareas alike.
 * Intended to sit inside a `grid lg:grid-cols-2` form per the two-column
 * desktop layout direction; full-width fields just span both columns.
 *
 * When `error` is set and `children` is a single element (true for every
 * current caller), the control is cloned with `aria-describedby` pointing at
 * the error message and `aria-invalid="true"` — so a screen reader announces
 * the error not just at submit time (the `role="alert"` below) but also
 * whenever the field regains focus later.
 */
export function FieldRow({
  label,
  htmlFor,
  error,
  hint,
  required,
  className,
  layout = "stacked",
  children,
}: FieldRowProps) {
  const errorId = error ? `${htmlFor}-error` : undefined;

  const control =
    errorId && isValidElement<{ "aria-describedby"?: string; "aria-invalid"?: boolean }>(children)
      ? cloneElement(children, {
          "aria-describedby": children.props["aria-describedby"]
            ? `${children.props["aria-describedby"]} ${errorId}`
            : errorId,
          "aria-invalid": true,
        })
      : children;

  const inline = layout === "inline";

  return (
    <div
      className={cn(
        inline
          ? "grid gap-1.5 sm:grid-cols-[11rem_minmax(0,1fr)] sm:items-center sm:gap-x-3"
          : "flex flex-col gap-1.5",
        className
      )}
    >
      <label
        htmlFor={htmlFor}
        className={cn("text-sm font-medium text-brand-dark", inline && "sm:py-2")}
      >
        {label}
        {required ? (
          <span className="ml-0.5 text-destructive" aria-hidden="true">
            *
          </span>
        ) : null}
      </label>
      {control}
      {error ? (
        <p id={errorId} role="alert" className={cn("text-sm text-destructive", inline && "sm:col-start-2")}>
          {error}
        </p>
      ) : hint ? (
        <p className={cn("text-sm text-slate-500", inline && "sm:col-start-2")}>{hint}</p>
      ) : null}
    </div>
  );
}
