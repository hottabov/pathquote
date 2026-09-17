import type { FormContext, XlsxFormSpec } from "../types";

/**
 * The "machine sale" header block, shared verbatim by the EasyFeeder, HDRF,
 * Punchline and FabricPro Trolley forms. All four were drawn from the same
 * master, down to the column: `Distributor:` in D10, `Name:` in M10, then an
 * End User block whose labels run down column G from row 14.
 *
 * Where each value goes was not guessed. The Fabric Trolley original in
 * `RAW/Order Forms/` was left filled in by whoever last used it -- PATAUS in
 * G10, JPH in O10, "Expo Produccion Mexico" in I14 -- so the sheet itself
 * says which blank a human writes in. (Those three cells, and the quantity,
 * are blanked in the committed template; a sample company name printing on
 * every trolley order would be worse than no form at all.)
 *
 * The +2 column offset is not decoration: a label sits in a narrow 4.3-wide
 * column and depends on overflowing rightwards, so the cell immediately after
 * it is part of the label, not the blank beside it. Writing one column closer
 * clips the label -- the M-Series spike lost the "Name:" label to exactly
 * this and the note is repeated in every spec since.
 *
 * `Fax:` (G21) has no value: nothing in the app stores one. `Application:`
 * (G24) has none either -- it is the customer's use for the machine, which
 * the quote does not ask for. Both print blank, as they did on paper.
 */
export function machineSaleHeader(): XlsxFormSpec["values"] {
  return [
    { cell: "G10", from: (c: FormContext) => c.distributorName },
    { cell: "O10", from: (c: FormContext) => c.authorName },
    { cell: "I14", from: (c: FormContext) => c.company.name },
    { cell: "I15", from: (c: FormContext) => c.company.addressLines[0] },
    { cell: "I16", from: (c: FormContext) => c.company.addressLines[1] },
    { cell: "I17", from: (c: FormContext) => c.company.addressLines[2] },
    { cell: "I18", from: (c: FormContext) => c.contact.fullName },
    { cell: "I19", from: (c: FormContext) => c.contact.position },
    { cell: "I20", from: (c: FormContext) => c.contact.phone },
    { cell: "I22", from: (c: FormContext) => c.contact.email },
    { cell: "I23", from: (c: FormContext) => c.company.industry },
  ];
}

/**
 * A tick driven by an option the item carries. Repeated in every spec file
 * rather than shared from one place, historically, because `covers` ties it
 * to a role and the roles differ per form -- but these five forms tick the
 * crate and nothing else, so one helper serves all of them.
 */
export const crateTick = (cell: string) =>
  ({
    cell,
    when: (c: FormContext) => c.item.options.some((option) => option.role === "CRATE"),
    covers: "CRATE",
  }) as const;
