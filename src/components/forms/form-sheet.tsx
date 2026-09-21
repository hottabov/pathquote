import type { ReactNode } from "react";
import { FORM_SHEET_CSS } from "./form-sheet-css";
import { PATHFINDER_LOGO_SVG } from "./logo";
import { Field } from "./primitives";
import type { FormContext } from "@/lib/production-forms/types";

/**
 * Head office contact details, as the approved mockups print them.
 *
 * Hardcoded because there is nowhere else to read them from: `Region` carries
 * an entity name, legal id and address, but no phone, email or website. That
 * makes these correct for AU and wrong for any other region, which is a
 * reason to add the three columns rather than to invent values here -- noted
 * in docs/specs/2026-09-11-order-forms-backlog.md.
 */
const HEAD_OFFICE = {
  phone: "+61 3 9338 3471",
  email: "orders@pathfindercut.com",
  website: "www.pathfindercut.com",
};

/** dd.mm.yyyy, as the mockups' provenance line prints it. */
function formatStamp(date: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getDate())}.${pad(date.getMonth() + 1)}.${date.getFullYear()}`;
}

/**
 * Where this page came from, printed along the bottom of every form:
 * `M-SERIES · Q-AU-2026-014 · item 1 of 3 · 11.09.2026`.
 */
export function provenance(ctx: FormContext, formId: string): string {
  return [
    formId.toUpperCase(),
    ctx.documentNumber,
    `item ${ctx.itemIndex} of ${ctx.itemCount}`,
    formatStamp(ctx.generatedAt),
  ]
    .filter(Boolean)
    .join(" · ");
}

/** What the masthead and the meta strip print, on any sheet. */
export type SheetHeader = {
  title: string;
  distributorName: string;
  authorName: string;
  documentNumber: string;
  /** The entity logo as a data URI, or null to print the Pathfinder wordmark. */
  logo: string | null;
  /** The line under the form title. Machine forms print "Production order". */
  kicker?: string;
};

/**
 * The A4 page every form is drawn on: masthead, the distributor/salesperson/
 * quote strip, then whatever the form itself puts below.
 *
 * Takes plain fields rather than a `FormContext` so the sheets that belong to
 * the whole quote rather than to one machine -- the Software Order Form --
 * are drawn by the same shell as the machine forms. `FormSheet` is the
 * machine-form wrapper over it.
 *
 * The stylesheet travels with the first sheet only -- a document holding
 * three forms needs one copy of it, not three. `FormDocument` handles that.
 */
export function SheetShell({
  header,
  dense = false,
  children,
}: {
  header: SheetHeader;
  dense?: boolean;
  children: ReactNode;
}) {
  return (
    <div className={dense ? "pf-sheet pf-dense" : "pf-sheet"}>
      <div className="pf-mast">
        {/* The entity's own logo when the region has uploaded one, and the
            Pathfinder wordmark otherwise. Never a text fallback: the paper
            forms all carried the mark, and a sheet arriving at the workshop
            without it does not look like a Pathfinder order. */}
        {header.logo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="pf-logo" src={header.logo} alt={header.distributorName} />
        ) : (
          <div className="pf-logo" dangerouslySetInnerHTML={{ __html: PATHFINDER_LOGO_SVG }} />
        )}

        <div className="pf-doctitle">
          {header.title}
          <small>{header.kicker ?? "Production order"}</small>
        </div>

        <div className="pf-contact">
          <div>
            <b>{HEAD_OFFICE.phone}</b>
          </div>
          <div>{HEAD_OFFICE.email}</div>
          <div>{HEAD_OFFICE.website}</div>
        </div>
      </div>

      <div className="pf-metastrip">
        <Field label="Distributor" value={header.distributorName} />
        <Field label="Salesperson" value={header.authorName} />
        <Field label="Quote ref." value={header.documentNumber} num />
      </div>

      {children}
    </div>
  );
}

/** The machine-form sheet: `SheetShell` fed from a `FormContext`. */
export function FormSheet({
  ctx,
  title,
  dense = false,
  children,
}: {
  ctx: FormContext;
  title: string;
  /**
   * Tightens the vertical rhythm. Set only where a sheet genuinely carries
   * more than the others and would otherwise run to a second page -- the
   * L-Series, which prints two reference blocks at its foot on top of
   * everything the cutter forms have. One form, one A4 page is the rule the
   * workshop's filing depends on.
   */
  dense?: boolean;
  children: ReactNode;
}) {
  return (
    <SheetShell
      header={{
        title,
        distributorName: ctx.distributorName,
        authorName: ctx.authorName,
        documentNumber: ctx.documentNumber,
        logo: ctx.logo,
      }}
      dense={dense}
    >
      {children}
    </SheetShell>
  );
}

/**
 * The end user band, identical on every form that has one -- which is every
 * form except the Leather Nesting Station, whose sheet is a fixed list of
 * contents.
 *
 * No delivery address: delivery is logistics' job and gets its own document
 * (docs/specs/2026-09-11-order-forms-backlog.md, "Logistics"). A workshop
 * sheet that names a destination reads as something the workshop arranges.
 * Three rows, four columns -- the band used to be two stacked columns and
 * took twice the height.
 */
export function EndUserSection({ ctx }: { ctx: FormContext }) {
  return (
    <EndUserBand
      company={ctx.company}
      contact={ctx.contact}
      machine={`${ctx.item.code} — ${ctx.item.name}`}
    />
  );
}

/**
 * The band itself, on plain fields. `machine` is omitted on a sheet that
 * belongs to the quote rather than to one machine (the Software Order Form),
 * and the email takes that column instead of sitting on its own.
 */
export function EndUserBand({
  company,
  contact,
  machine,
}: {
  company: FormContext["company"];
  contact: FormContext["contact"];
  machine?: string;
}) {
  return (
    <div className="pf-sec">
      <h2>
        <span>End user</span>
      </h2>
      <div className="pf-eu">
        <div className="pf-s2">
          <Field label="Company" value={company.name} />
        </div>
        <div className="pf-s2">
          {machine ? <Field label="Machine" value={machine} /> : <Field label="Email" value={contact.email} full />}
        </div>
        <div className="pf-s3">
          <Field label="Address" value={company.addressLines.join(", ")} />
        </div>
        <Field label="Industry" value={company.industry} />
        <Field label="Contact" value={contact.fullName} />
        <Field label="Title" value={contact.position} />
        <Field label="Phone" value={contact.phone} num />
        {machine ? <Field label="Email" value={contact.email} full /> : null}
      </div>
    </div>
  );
}

/**
 * Every form for one quote, in one document: a single stylesheet and one
 * `.pf-sheet` per machine, each breaking onto its own page. One HTML
 * document means one Gotenberg call, and no merging by filename.
 */
export function FormDocument({ children }: { children: ReactNode }) {
  return (
    <>
      <style dangerouslySetInnerHTML={{ __html: FORM_SHEET_CSS }} />
      {children}
    </>
  );
}

export { HEAD_OFFICE };
