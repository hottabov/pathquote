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

/**
 * The A4 page every form is drawn on: masthead, the distributor/salesperson/
 * quote strip, then whatever the form itself puts below.
 *
 * The stylesheet travels with the first sheet only -- a document holding
 * three forms needs one copy of it, not three. `FormDocument` handles that.
 */
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
    <div className={dense ? "pf-sheet pf-dense" : "pf-sheet"}>
      <div className="pf-mast">
        {/* The entity's own logo when the region has uploaded one, and the
            Pathfinder wordmark otherwise. Never a text fallback: the paper
            forms all carried the mark, and a sheet arriving at the workshop
            without it does not look like a Pathfinder order. */}
        {ctx.logo ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img className="pf-logo" src={ctx.logo} alt={ctx.distributorName} />
        ) : (
          <div className="pf-logo" dangerouslySetInnerHTML={{ __html: PATHFINDER_LOGO_SVG }} />
        )}

        <div className="pf-doctitle">
          {title}
          <small>Production order</small>
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
        <Field label="Distributor" value={ctx.distributorName} />
        <Field label="Salesperson" value={ctx.authorName} />
        <Field label="Quote ref." value={ctx.documentNumber} num />
      </div>

      {children}
    </div>
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
    <div className="pf-sec">
      <h2>
        <span>End user</span>
      </h2>
      <div className="pf-eu">
        <div className="pf-s2">
          <Field label="Company" value={ctx.company.name} />
        </div>
        <div className="pf-s2">
          <Field label="Machine" value={`${ctx.item.code} — ${ctx.item.name}`} />
        </div>
        <div className="pf-s3">
          <Field label="Address" value={ctx.company.addressLines.join(", ")} />
        </div>
        <Field label="Industry" value={ctx.company.industry} />
        <Field label="Contact" value={ctx.contact.fullName} />
        <Field label="Title" value={ctx.contact.position} />
        <Field label="Phone" value={ctx.contact.phone} num />
        <Field label="Email" value={ctx.contact.email} full />
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
