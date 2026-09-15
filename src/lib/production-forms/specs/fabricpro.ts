import { fabricProSpecSchema } from "@/lib/validation/production-spec";
import type { FormContext, FormSpec } from "../types";

/**
 * The model row prints one box per width family. FP-TROLLEY prints nothing
 * here: it has its own form, out of scope, and carries no `form` at all.
 */
const modelCell = (widthCode: number | undefined) =>
  widthCode === undefined ? undefined : ({ 180: "H27", 220: "J27", 300: "M27" } as Record<number, string>)[widthCode];
const spec = (key: string, want: string) => (ctx: FormContext) => ctx.item.spec[key] === want;

/**
 * Rail length in metres: what someone typed on this item, else the length of
 * the one EasyLoader table this machine was paired with (`ctx.rails`).
 *
 * The typed value wins so the case the derivation cannot see -- a customer
 * whose existing table is being extended, or one re-using rails they already
 * own -- stays expressible. The two rails are always the same length (Jeff,
 * 2026-09-11: "Electrical power rail counts the same, right? -- Yep. Always
 * the same number"), so they share one derivation and differ only in which
 * manual override they read.
 */
const railLength = (key: "railLengthM" | "powerRailLengthM") => (ctx: FormContext) =>
  (ctx.item.spec[key] as number | undefined) ?? ctx.rails?.lengthM ?? undefined;

export const fabricProSpec: FormSpec = {
  id: "fabricpro",
  title: "Fabric Pro Order Form",
  renderer: "xlsx",
  template: "fabric-pro-order-form-08.xlsx",
  sheetPath: "xl/worksheets/sheet1.xml",
  form: "FABRICPRO",
  specSchema: fabricProSpecSchema,
  // "ui" is not listed: screenSideSchema defaults to -Y, so it can never be
  // missing. FabricPro has no other required field.
  requires: [],

  values: [
    { cell: "G10", from: (c) => c.distributorName },
    // O10, not N10: "Name:" in M10 needs N10 to overflow into, or it clips
    // to "Nam". Same trap as M-Series at M8 and EasyLoader at N11.
    { cell: "O10", from: (c) => c.authorName },
    // H14 is the Company line -- borderless because the rule under it is
    // H15's top border. H15-H17 are the three Address lines.
    { cell: "H14", from: (c) => c.company.name },
    { cell: "H15", from: (c) => c.company.addressLines[0] },
    { cell: "H16", from: (c) => c.company.addressLines[1] },
    { cell: "H17", from: (c) => c.company.addressLines[2] },
    { cell: "H18", from: (c) => c.contact.fullName },
    { cell: "H19", from: (c) => c.contact.position },
    { cell: "H20", from: (c) => c.contact.phone },
    { cell: "H22", from: (c) => c.contact.email },
    { cell: "H23", from: (c) => c.company.industry },
    { cell: "O15", from: (c) => c.deliveryAddressLines[0] },
    { cell: "O16", from: (c) => c.deliveryAddressLines[1] },
    { cell: "O17", from: (c) => c.deliveryAddressLines[2] },
    { cell: "N46", from: railLength("railLengthM") },
    { cell: "N48", from: railLength("powerRailLengthM") },
  ],

  replaces: [],

  ticks: [
    { cell: "H27", when: (c) => modelCell(c.item.specs.widthCode) === "H27" },
    { cell: "J27", when: (c) => modelCell(c.item.specs.widthCode) === "J27" },
    { cell: "M27", when: (c) => modelCell(c.item.specs.widthCode) === "M27" },

    // The form prints one voltage and notes it is the only one available.
    { cell: "H35", when: () => true },

    { cell: "J41", when: spec("ui", "-Y") },
    { cell: "O41", when: spec("ui", "+Y") },

    // Fitted to every machine, so ticked unconditionally rather than asked.
    { cell: "J44", when: () => true },
    { cell: "J46", when: (c) => Boolean(railLength("railLengthM")(c)) },
    { cell: "J48", when: (c) => Boolean(railLength("powerRailLengthM")(c)) },

    // D58 (Ex-Works) is deliberately not ticked: the delivery term belongs to
    // the quote, not to the build sheet (Vadym, 2026-09-11).
    // From the option line, and declared as covered: a `Crate-FP` read out of
    // the production spec instead would tick nothing and be reported as an
    // option this form has no box for.
    {
      cell: "D68",
      when: (c) => c.item.options.some((option) => option.role === "CRATE"),
      covers: "CRATE" as const,
    },
  ],
};
