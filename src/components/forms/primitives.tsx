import type { ReactNode } from "react";

/**
 * The pieces every production order form is assembled from.
 *
 * Their markup is lifted from the approved mockups
 * (`docs/mockups/*-order-form.html`) and their class names match
 * `FORM_SHEET_CSS`. Layout differences between forms are real -- the
 * EasyLoader's table sections, the L-Series' consumables block -- so the
 * forms themselves are JSX rather than a schema; these are only the parts
 * every one of them shares.
 *
 * Nothing here is interactive. These render once, to a static string, and
 * are printed.
 */

/** A field label: the small uppercase caption above a ruled value. */
export function Label({ children }: { children: ReactNode }) {
  return <span className="pf-lb">{children}</span>;
}

/**
 * One labelled value on a ruled line.
 *
 * `full` is for contact data, which is never abbreviated -- an ellipsised
 * email is a wrong email, so it wraps instead. `num` turns on tabular
 * figures, for anything a reader scans as a column of digits.
 */
export function Field({
  label,
  value,
  full = false,
  num = false,
}: {
  label: ReactNode;
  value?: ReactNode;
  full?: boolean;
  num?: boolean;
}) {
  const cls = ["pf-vl", full ? "pf-full" : "", num ? "pf-num" : ""].filter(Boolean).join(" ");
  return (
    <div className="pf-fld">
      <Label>{label}</Label>
      <span className={cls}>{value}</span>
    </div>
  );
}

/**
 * Several ruled lines under one label -- an address block. The rows sit
 * directly on each other so the block reads as one field rather than as
 * three unrelated ones. Empty lines are kept: the workshop writes on them.
 */
export function LinesField({ label, lines, rows = 3 }: { label: ReactNode; lines: string[]; rows?: number }) {
  return (
    <div className="pf-fld pf-lines">
      <Label>{label}</Label>
      {Array.from({ length: Math.max(rows, lines.length) }, (_, i) => (
        <span key={i} className="pf-ln">
          {lines[i] ?? ""}
        </span>
      ))}
    </div>
  );
}

/** A titled band. `hint` is the grey aside on the right of the heading. */
export function Section({
  title,
  hint,
  children,
  style,
}: {
  title: ReactNode;
  hint?: ReactNode;
  children: ReactNode;
  style?: React.CSSProperties;
}) {
  return (
    <div className="pf-sec" style={style}>
      <h2>
        <span>{title}</span>
        {hint ? <span className="pf-hint">{hint}</span> : null}
      </h2>
      {children}
    </div>
  );
}

/** Two sections sharing one band, when neither fills a row on its own. */
export function SectionRow({ children }: { children: ReactNode }) {
  return (
    <div className="pf-secrow" style={{ marginTop: "3.2mm" }}>
      {children}
    </div>
  );
}

/**
 * One tick box and its text.
 *
 * The box is drawn, never glyphed: a checkmark character depends on a font
 * the PDF renderer may not have, and a background image is dropped by some
 * print paths. `lead` is the larger single-line variant used for model,
 * width and interface rows -- the box stays the same size everywhere, only
 * the text grows.
 */
export function Tick({
  on = false,
  lead = false,
  std = false,
  qty,
  code,
  desc,
  children,
  style,
}: {
  on?: boolean;
  lead?: boolean;
  /**
   * Fitted as standard rather than chosen -- the X-Calibre's IKA, AFP and
   * HFV, the L-Series' MRK. Marked the same way, so the workshop still reads
   * "this is on the machine", but in grey so nobody goes looking for who
   * ticked it or what it cost.
   */
  std?: boolean;
  /**
   * A quantity, for the L-Series tools row: the printed form says to replace
   * the X with a number when more than one is required, so one box carries
   * both states -- a mark for 1, the figure itself for 2 or more. Absent or
   * 0 means not ordered.
   */
  qty?: number;
  code?: ReactNode;
  desc?: ReactNode;
  children?: ReactNode;
  style?: React.CSSProperties;
}) {
  const showQty = qty !== undefined && qty > 1;
  const cls = [
    "pf-tick",
    lead ? "pf-lead" : "",
    std ? "pf-std" : "",
    showQty ? "pf-qty" : on || (qty !== undefined && qty === 1) ? "pf-on" : "",
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <label className={cls} style={style}>
      <span className="pf-bx">{showQty ? <span className="pf-q">{qty}</span> : null}</span>
      <span className="pf-tx">
        {children ?? (
          <>
            {code ? <span className="pf-code">{code}</span> : null}
            {code && desc ? " " : null}
            {desc ? <span className="pf-desc">{desc}</span> : null}
          </>
        )}
      </span>
    </label>
  );
}

/** A grid of ticks. */
export function TickGrid({
  variant,
  stacked = false,
  children,
}: {
  /**
   * Column count, as the mockups name it: the default three-up options grid,
   * `four` for model and width rows, `five` for the PathWorks modules, `row`
   * for a short wrapping line, `col` and `one` for a single column (`col`
   * shrink-wraps each tick, `one` lets them fill the width so the selected
   * band reads across).
   */
  variant?: "four" | "five" | "row" | "col" | "one";
  stacked?: boolean;
  children: ReactNode;
}) {
  const cls = ["pf-opts", variant ? `pf-${variant}` : "", stacked ? "pf-stacked" : ""]
    .filter(Boolean)
    .join(" ");
  return <div className={cls}>{children}</div>;
}

/**
 * The X-Calibre's option block: three named columns mirroring the printed
 * form's own grouping -- what was chosen, power and packing, and what is
 * fitted as standard.
 */
export function OptionColumns({ children }: { children: ReactNode }) {
  return <div className="pf-optcols">{children}</div>;
}

export function OptionColumn({ caption, children }: { caption: ReactNode; children: ReactNode }) {
  return (
    <div className="pf-optcol">
      <span className="pf-cap">{caption}</span>
      <div className="pf-opts pf-one">{children}</div>
    </div>
  );
}

/** A measured figure on a short rule, with its unit -- "12 metres". */
export function InlineValue({ label, value, unit }: { label?: ReactNode; value: ReactNode; unit: string }) {
  return (
    <span className="pf-inlinefld">
      {label ? (
        <span className="pf-desc" style={{ fontSize: "7.4pt" }}>
          {label}
        </span>
      ) : null}
      <span className="pf-run">{value}</span>
      <span className="pf-unit">{unit}</span>
    </span>
  );
}

/** A bordered block of free text -- drills, special notes. */
export function WriteIn({
  label,
  warn,
  children,
}: {
  /** Omitted when the section heading already says what the block is. */
  label?: ReactNode;
  warn?: ReactNode;
  /** Omitted for a block nobody fills in on screen -- the workshop writes in it. */
  children?: ReactNode;
}) {
  return (
    <div className="pf-writein">
      {label || warn ? (
        <Label>
          {label}
          {warn ? <span className="pf-warn">{warn}</span> : null}
        </Label>
      ) : null}
      {children}
    </div>
  );
}

/**
 * The block the workshop fills in by hand. Dashed rules and a distinct
 * ground, so "not ours to fill" is visible rather than conventional -- these
 * fields are blank by design and always will be.
 */
export function OfficeUse({
  fields,
  signature,
  hint = "completed by hand in the workshop",
}: {
  fields: string[];
  signature?: string;
  /** Who fills the block in -- the workshop on a machine form, the office on
   * the Software Order Form, which nothing is built from. */
  hint?: string;
}) {
  return (
    <div className="pf-office">
      <h2>
        <span>Office use only</span>
        <span className="pf-hint">{hint}</span>
      </h2>
      <div className="pf-officegrid">
        {fields.map((label) => (
          <Field key={label} label={label} />
        ))}
        {signature ? (
          <div className="pf-sign">
            <Field label={signature} />
            <Field label="Date" />
          </div>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The line along the bottom: any rule the form prints in words on the left,
 * and on the right where this page came from -- which form, which quote,
 * which item, when. That provenance is what lets somebody holding a printed
 * page a month later find the quote it was made from.
 */
export function Footnote({ note, provenance }: { note?: ReactNode; provenance: string }) {
  return (
    <div className="pf-footnote">
      <span>{note}</span>
      <span className="pf-prov">{provenance}</span>
    </div>
  );
}
