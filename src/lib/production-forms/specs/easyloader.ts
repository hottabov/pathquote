import type { OptionRole } from "@prisma/client";
import { easyLoaderSpecSchema } from "@/lib/validation/production-spec";
import type { ProductSpecs } from "@/lib/validation/product-specs";
import { EL_MODULE_ROLE_LIST, layoutTotals } from "../table-sections";
import type { FormContext, FormSpec } from "../types";

/**
 * The form prints a box for two table widths and a "Custom ___mm" line for
 * everything else. Which one an EasyLoader ticks is a fact about its width
 * (`Product.specs.tableWidthMm`), not its code. Exported for the builder,
 * which offers the custom-width field exactly when there is no printed box.
 */
export function easyLoaderPrintedWidthCell(specs: ProductSpecs): "I31" | "I33" | null {
  switch (specs.tableWidthMm) {
    case 2020:
      return "I31";
    case 2420:
      return "I33";
    default:
      return null;
  }
}

type Section = { lengthM: number; surface: "static" | "conveyor" };

const sections = (ctx: FormContext) => (ctx.item.spec.sections ?? []) as Section[];

/**
 * How many single roll feed attachments were sold on this item. The option is
 * per width (`EL-2020-RF` / `EL-2420-RF`) and carries role `EL_ROLL_FEED`, so
 * this is the same lookup every other option tick makes -- it just needs the
 * quantity rather than the presence.
 */
const rollFeedQty = (ctx: FormContext) =>
  ctx.item.options
    .filter((option) => option.role === "EL_ROLL_FEED")
    .reduce((sum, option) => sum + option.qty, 0);
const spec = (key: string, want: string) => (ctx: FormContext) => ctx.item.spec[key] === want;

/**
 * An option tick. `covers` records the same role so `unmatchedOptions`
 * knows this form has a box for it -- without it, the crate and roll holder
 * would be reported as unmapped and printed a second time on the
 * "Additional items" sheet. Mirrors the helper in specs/m-series.ts.
 */
const optionTick = (cell: string, role: OptionRole) => ({
  cell,
  when: (ctx: FormContext) => ctx.item.options.some((option) => option.role === role),
  covers: role,
});

/** Length value box and the two surface tick boxes, per table section. */
const SECTION_CELLS = [
  { length: "I43", static: "I45", conveyor: "K45" },
  { length: "I47", static: "I49", conveyor: "K49" },
  { length: "I51", static: "I53", conveyor: "K53" },
];

export const easyLoaderSpec: FormSpec = {
  id: "easyloader",
  title: "EasyLoader Order Form",
  renderer: "xlsx",
  template: "easy-loader-13.xlsx",
  sheetPath: "xl/worksheets/sheet1.xml",
  form: "EASYLOADER",
  specSchema: easyLoaderSpecSchema,
  // "ui" is not listed: screenSideSchema defaults to -Y, so it can never be
  // missing. "sections" is not listed either: an empty array legitimately
  // means one undivided table -- see easyLoaderSpecSchema. What gates
  // finalize is reconciling the layout against the options sold (Task 5),
  // not the presence of this field.
  requires: ["usage"],

  // The options the table layout is made of have no box of their own: the
  // section rows and the "Total Table is N m" line at M54 are how this form
  // states them. Declaring them here keeps them off the Additional items
  // sheet, which exists for things the form genuinely cannot express. The
  // busbar and the support rail are here for the same reason -- they are one
  // per module of a table the form already draws.
  coversOptions: [...EL_MODULE_ROLE_LIST],

  values: [
    { cell: "G11", from: (c) => c.distributorName },
    // O11, not N11: the "Name:" label sits in M11, which is 3.7 characters
    // wide, so it needs N11 to overflow into. Writing there clips it to
    // "Nam" -- the same trap the M-Series map fell into at M8.
    { cell: "O11", from: (c) => c.authorName },
    // H15 is the Company line: it looks borderless because the rule under it
    // is drawn as H16's top border. H16-H18 are the three Address lines.
    { cell: "H15", from: (c) => c.company.name },
    { cell: "H16", from: (c) => c.company.addressLines[0] },
    { cell: "H17", from: (c) => c.company.addressLines[1] },
    { cell: "H18", from: (c) => c.company.addressLines[2] },
    { cell: "H19", from: (c) => c.contact.fullName },
    { cell: "H20", from: (c) => c.contact.position },
    { cell: "H21", from: (c) => c.contact.phone },
    { cell: "H23", from: (c) => c.contact.email },
    { cell: "H24", from: (c) => c.company.industry },
    { cell: "O16", from: (c) => c.deliveryAddressLines[0] },
    { cell: "O17", from: (c) => c.deliveryAddressLines[1] },
    { cell: "O18", from: (c) => c.deliveryAddressLines[2] },
    ...SECTION_CELLS.map((cells, index) => ({
      cell: cells.length,
      from: (c: FormContext) => sections(c)[index]?.lengthM,
    })),
    // The "Qty." box beside the roll feed row. Read off the option line the
    // customer is charged for, not off the production spec -- one attachment
    // ordered is one attachment built, and two numbers for one fact is how
    // they come to disagree.
    { cell: "F61", from: (c) => rollFeedQty(c) || null },
    ...["K61", "K63", "K65", "K67"].map((cell, index) => ({
      cell,
      from: (c: FormContext) => (c.item.spec.rollFeedDistancesMm as number[] | undefined)?.[index],
    })),
    // M54 is blank in the template, in the same notes column as the three
    // "(Multiple of 1.2m...)" annotations, one row below section 3. The
    // total is added up from the sections rather than typed -- it is the one
    // place any form prints something the paper form never had, but the
    // workshop otherwise has to add up the section boxes by hand to get it.
    // Omitted entirely for an empty table: printing "Total Table is 0 m" is
    // worse than printing nothing.
    {
      cell: "M54",
      from: (c) => {
        const totalM = layoutTotals(sections(c)).totalM;
        return totalM > 0 ? `Total Table is ${totalM} m` : null;
      },
    },
    // E73 is the blank row between "Crate Required" and "Office Use Only",
    // in the same column as every other option label on this form.
    //
    // The rails belong to the FabricPro that runs over this table, so when one
    // claimed it they print there and this stays empty -- two printed lengths
    // would have stores pick two sets. `ctx.rails` is set on a table's own
    // context only while no FabricPro claimed it (the customer already owns
    // theirs, or three tables were sold with two machines), and then there is
    // no other sheet: a length nobody prints is a length nobody orders.
    {
      cell: "E73",
      from: (c) => {
        const railM = c.rails?.lengthM;
        return railM
          ? `FabricPro rails: travel platform rail ${railM} m + electrical power rail ${railM} m`
          : null;
      },
    },
  ],

  // J35 holds the printed label "  Custom     ___________mm". There is no
  // blank beside it, so the whole label is rewritten. This is the only place
  // in any spec that overwrites printed text -- hence its own field.
  replaces: [
    {
      cell: "J35",
      from: (c) => {
        const width = c.item.spec.customWidthMm as number | undefined;
        return width ? `  Custom     ${width}mm` : null;
      },
    },
  ],

  ticks: [
    { cell: "I31", when: (c) => easyLoaderPrintedWidthCell(c.item.specs) === "I31" },
    { cell: "I33", when: (c) => easyLoaderPrintedWidthCell(c.item.specs) === "I33" },
    { cell: "I35", when: (c) => easyLoaderPrintedWidthCell(c.item.specs) === null },

    { cell: "I38", when: spec("usage", "onload") },
    { cell: "O38", when: spec("usage", "offload") },
    { cell: "I40", when: spec("ui", "-Y") },
    { cell: "O40", when: spec("ui", "+Y") },

    ...SECTION_CELLS.flatMap((cells, index) => [
      { cell: cells.static, when: (c: FormContext) => sections(c)[index]?.surface === "static" },
      { cell: cells.conveyor, when: (c: FormContext) => sections(c)[index]?.surface === "conveyor" },
    ]),

    // Synchronisation with the cutter: a build answer, defaulting to yes, so
    // an absent spec still prints the tick (see `syncWithCutter`). There is
    // no EL_SYNC option in the catalogue to read -- nobody is charged for it.
    { cell: "D56", when: (c) => c.item.spec.syncWithCutter !== false },
    optionTick("D59", "EL_ROLL_FEED"),
    optionTick("D69", "EL_ROLL_HOLDER"),
    optionTick("D71", "CRATE"),
  ],
};
