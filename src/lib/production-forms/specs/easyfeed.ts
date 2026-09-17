import { z } from "zod";
import type { ProductSpecs } from "@/lib/validation/product-specs";
import type { FormContext, FormSpec } from "../types";
import { crateTick, machineSaleHeader } from "./shared-header";

/**
 * Which printed model box an EasyFeeder ticks, from its table width.
 * The row reads EF180 / EF220 / EF320 in centimetres of spreading width;
 * `Product.specs.tableWidthMm` is the table those correspond to.
 *
 * `EF-4030` has no box of its own and takes the "Other?______mm" line, the
 * same way an EasyLoader wider than 2420 takes its "Custom" line. Jeff asked
 * for that line to go ("how often we are doing specific one? Probably never")
 * and it will, when the form is redrawn in HTML -- but dropping it while
 * EF-4030 is still in the catalogue would leave that machine with no box at
 * all, which is the one outcome worse than an unused line.
 */
const PRINTED_WIDTH: Record<number, string> = { 2020: "H28", 2420: "J28", 3220: "L28" };

export function easyFeedWidthCell(specs: ProductSpecs): string | null {
  return specs.tableWidthMm === undefined ? null : (PRINTED_WIDTH[specs.tableWidthMm] ?? null);
}

/**
 * The EasyFeeder asks the customer nothing the quote does not already hold:
 * Jeff's whole list was "we need to know what size it is, we need to know
 * what voltage it is", and the size is the product. The voltage box is
 * pre-ticked on the template at its only available value, so there is no
 * production spec here at all -- an empty object rather than a schema with
 * optional fields nobody fills.
 */
export const easyFeedSpecSchema = z.object({});

export const easyFeedSpec: FormSpec = {
  id: "easyfeed",
  title: "EasyFeed Order Form",
  renderer: "xlsx",
  template: "easy-feed-order-form-05.xlsx",
  sheetPath: "xl/worksheets/sheet1.xml",
  form: "EASYFEED",
  specSchema: easyFeedSpecSchema,
  requires: [],

  values: [...machineSaleHeader()],

  // P28 prints "Other?__________mm". A width with no box of its own writes
  // its millimetres over that label, exactly as the EasyLoader form does at
  // J35 -- there is no blank beside it to fill.
  replaces: [
    {
      cell: "P28",
      from: (c) =>
        easyFeedWidthCell(c.item.specs) === null && c.item.specs.tableWidthMm !== undefined
          ? `Other?  ${c.item.specs.tableWidthMm}mm`
          : null,
    },
  ],

  ticks: [
    ...Object.values(PRINTED_WIDTH).map((cell) => ({
      cell,
      when: (c: FormContext) => easyFeedWidthCell(c.item.specs) === cell,
    })),
    // The "Other?" box, ticked for a width the row has no name for.
    { cell: "O28", when: (c) => easyFeedWidthCell(c.item.specs) === null },

    // Voltage (H36) carries a printed X: 240/50 is the only one available,
    // so it is a fact about the machine rather than a question. Left alone.
    // D48 (Ex-Works) is left blank: delivery terms belong to logistics,
    // not to a workshop sheet (Vadym, 2026-09-16).
    crateTick("D60"),
  ],
};
