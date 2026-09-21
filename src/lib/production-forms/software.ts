/**
 * The Software Order Form's list of programs.
 *
 * Martin's form, not Jeff's: it is the order for software the customer runs
 * on their own computer, so it has no machine, no options and nothing to
 * build. One sheet per quote, listing every program the catalogue sells with
 * a box beside it, ticked for the ones on this quote (Vadym, 2026-09-18).
 *
 * The list is written out rather than read from the catalogue at render time
 * for the same reason every other form's boxes are: a printed form is a
 * fixed sheet, and a program appearing on it because somebody added a
 * catalogue row is how a form starts disagreeing with the paper in the
 * folder. `tests/software-form.test.tsx` fails when the catalogue's SW
 * series and this list stop matching, so adding a program is a deliberate
 * edit here.
 *
 * Order follows the licence first, then the modules that run inside it, then
 * the two standalone tools -- which is how the sheet reads, not how the
 * catalogue sorts.
 */
export type SoftwareBox = { code: string; name: string };

export const SOFTWARE_BOXES: SoftwareBox[] = [
  { code: "PTW-S", name: "PathWorks Standalone" },
  { code: "PTW-I", name: "PathWorks Integrated" },
  { code: "PDG", name: "PhotoDigitiser" },
  { code: "WPN", name: "Panel Wizard" },
  { code: "WPL", name: "PoolLiner Wizard" },
  { code: "ANT-V5", name: "Automatic Nester V5" },
  { code: "ANT-V6", name: "Automatic Nester V6" },
  { code: "PRA", name: "Production Analyst" },
  { code: "LSC", name: "LS Convert" },
];

/** One SOFTWARE item on the quote. */
export type SoftwareItem = { code: string; name: string; qty: number };

/**
 * What the sheet needs, which is the document rather than any one item --
 * software has no machine to hang off.
 */
export type SoftwareFormContext = {
  distributorName: string;
  authorName: string;
  company: { name: string; addressLines: string[]; industry: string | null };
  contact: { fullName: string; position: string | null; phone: string | null; email: string | null };
  documentNumber: string;
  generatedAt: Date;
  logo: string | null;
  /** The SOFTWARE products sold on this quote. */
  items: SoftwareItem[];
};

/** Quantity ordered for a box's code, or 0 when it is not on the quote. */
export function softwareQty(items: SoftwareItem[], code: string): number {
  return items
    .filter((item) => item.code.toUpperCase() === code.toUpperCase())
    .reduce((sum, item) => sum + item.qty, 0);
}

/**
 * Software on the quote that this sheet has no box for -- a catalogue row
 * added since the list above was written. Printed under the boxes rather
 * than dropped, the same rule the machine forms follow with an option they
 * cannot express.
 */
export function unlistedSoftware(items: SoftwareItem[]): SoftwareItem[] {
  const listed = new Set(SOFTWARE_BOXES.map((box) => box.code.toUpperCase()));
  return items.filter((item) => !listed.has(item.code.toUpperCase()));
}
