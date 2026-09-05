import type { OptionRole } from "@prisma/client";
import { mSeriesSpecSchema } from "@/lib/validation/production-spec";
import type { ProductSpecs } from "@/lib/validation/product-specs";
import type { FormContext, FormSpec } from "../types";

/** The model row prints M3/M5/M7/M10 boxes; `Product.specs.modelTier` names which. */
const model = (want: string) => (ctx: FormContext) => ctx.item.specs.modelTier === want;
/** The width row prints the family (180/220/300/390), which is `specs.widthCode`, not the real cut. */
const width = (want: number) => (ctx: FormContext) => ctx.item.specs.widthCode === want;

/**
 * An option tick. The form prints one box per kind of option, and the
 * catalogue names that kind as `Option.role` (ABR-M and ABR-X both carry
 * ABR). `covers` records the same role so `unmatchedOptions` can tell
 * what this form has no box for.
 */
const optionTick = (cell: string, role: OptionRole) => ({
  cell,
  when: (ctx: FormContext) => ctx.item.options.some((option) => option.role === role),
  covers: role,
});

const spec = (key: string, want: string) => (ctx: FormContext) => ctx.item.spec[key] === want;

/**
 * PathWorks modules tick this form only when the quote carries the integrated
 * PathWorks. With the standalone one they belong on the Software Order Form
 * instead -- two different orders, not a duplication. See spec section 6.3.
 */
const integrated = (module: NonNullable<ProductSpecs["pathworksModule"]>) => (ctx: FormContext) =>
  ctx.software.some((s) => s.specs.softwareMode === "integrated") &&
  ctx.software.some((s) => s.specs.pathworksModule === module);

export const mSeriesSpec: FormSpec = {
  id: "m-series",
  title: "M-Series Order Form",
  template: "m-series-order-12.xlsx",
  sheetPath: "xl/worksheets/sheet1.xml",
  form: "M_SERIES",
  specSchema: mSeriesSpecSchema,
  // "ui" is not listed: screenSideSchema defaults to -Y, so it can never be
  // missing -- leaving it here would permanently disable the download button
  // for any spec stored before that default existed.
  requires: ["knifeSize", "drills"],

  values: [
    { cell: "G8", from: (c) => c.distributorName },
    // N8, not M8: the "Name:" label sits in the 4.3-character-wide L8 and
    // depends on overflowing rightwards. Writing into M8 clips it to "Nam".
    { cell: "N8", from: (c) => c.authorName },
    // This form has no separate "Company:" row -- the End User block goes
    // straight to "Address:" -- so the name takes the first of the three
    // address slots and the address gets the other two. `companyAddressLines`
    // can return three lines (street, locality, country), so the tail is
    // joined into the last slot rather than silently dropping the country.
    { cell: "H13", from: (c) => c.company.name },
    { cell: "H14", from: (c) => c.company.addressLines[0] },
    { cell: "H15", from: (c) => c.company.addressLines.slice(1).join(", ") },
    { cell: "H16", from: (c) => c.contact.fullName },
    { cell: "H17", from: (c) => c.contact.position },
    { cell: "H18", from: (c) => c.contact.phone },
    { cell: "H20", from: (c) => c.contact.email },
    { cell: "H21", from: (c) => c.company.industry },
    { cell: "M13", from: (c) => c.deliveryAddressLines[0] },
    { cell: "M14", from: (c) => c.deliveryAddressLines[1] },
    { cell: "M15", from: (c) => c.deliveryAddressLines[2] },
    {
      cell: "M73",
      from: (c) =>
        c.item.options.find((option) => option.role === "MTS")?.attributes?.metres as number | undefined,
    },
    // Rows 81-82 are the tall hand-writing rows and carry a large font, so
    // very little fits and the drills and notes columns collide. Cells and
    // caps below are the ones measured in the spike -- do not widen them
    // without printing a page and looking at it.
    { cell: "H81", from: (c) => ((c.item.spec.drills as { required?: boolean })?.required ? "Yes" : "No") },
    { cell: "J82", from: (c) => (c.item.spec.drills as { detail?: string })?.detail },
    { cell: "N81", from: (c) => c.item.spec.specialNotes as string | undefined },
  ],

  replaces: [],

  ticks: [
    { cell: "H25", when: model("M3") },
    { cell: "J25", when: model("M5") },
    { cell: "L25", when: model("M7") },
    { cell: "O25", when: model("M10") },

    { cell: "H29", when: width(180) },
    { cell: "J29", when: width(220) },
    { cell: "L29", when: width(300) },
    { cell: "O29", when: width(390) },

    { cell: "J33", when: spec("ui", "+Y") },
    { cell: "J35", when: spec("ui", "-Y") },

    optionTick("F42", "VRB"),
    optionTick("J42", "OFJ"),
    optionTick("O42", "HFV"),
    optionTick("F44", "PM"),
    optionTick("J44", "OFD"),
    optionTick("O44", "PRM"),
    optionTick("F46", "APM"),
    optionTick("J46", "OFP"),
    optionTick("O46", "DMT"),
    optionTick("F48", "DRG_3"),
    optionTick("J48", "MRK"),
    optionTick("O48", "CRATE"),
    optionTick("F50", "DRG_1"),
    optionTick("J50", "IJP"),
    optionTick("F52", "HDC"),
    optionTick("J52", "ABR"),
    optionTick("F55", "BCR"),
    optionTick("J55", "DR2"),
    optionTick("F57", "IKA"),
    optionTick("J57", "AFP"),

    // Box-then-label, same as every other tick in this column pair (F/G,
    // J/K, O/P): the tick belongs in O, not in P where the voltage label
    // text ("220V (TR220 External Xfmr)", etc.) actually lives.
    { cell: "O50", when: spec("voltage", "220V") },
    { cell: "O52", when: spec("voltage", "400V") },
    { cell: "O55", when: spec("voltage", "415V") },
    { cell: "O57", when: spec("voltage", "480V") },

    { cell: "F62", when: integrated("PDG") },
    { cell: "J62", when: integrated("WPN") },
    { cell: "O62", when: integrated("WPL") },
    { cell: "F64", when: integrated("ANT_V5") },
    { cell: "J64", when: integrated("ANT_V6") },

    { cell: "F68", when: spec("knifeSize", "1.5x5.0") },
    { cell: "J68", when: spec("knifeSize", "1.5x7.0") },
    { cell: "O68", when: spec("knifeSize", "2.0x7.0") },

    optionTick("D72", "MTS"),
  ],
};
