import { easyLoaderSpecSchema } from "@/lib/validation/production-spec";
import type { ProductSpecs } from "@/lib/validation/product-specs";
import { EL_MODULE_ROLE_LIST } from "../table-sections";
import type { HtmlFormSpec } from "../types";

/** The two table widths the form prints a box for. */
export const EASYLOADER_PRINTED_WIDTHS = [2020, 2420] as const;
export type EasyLoaderPrintedWidth = (typeof EASYLOADER_PRINTED_WIDTHS)[number];

/**
 * The printed width box this table ticks, or null for the "Custom ___mm"
 * line. A fact about the product (`Product.specs.tableWidthMm`), not its
 * code. Exported for the builder, which offers the custom-width field
 * exactly when there is no printed box.
 */
export function easyLoaderPrintedWidth(specs: ProductSpecs): EasyLoaderPrintedWidth | null {
  const width = specs.tableWidthMm;
  return EASYLOADER_PRINTED_WIDTHS.find((printed) => printed === width) ?? null;
}

/**
 * EasyLoader. Drawn by `EasyLoaderForm` (src/components/forms/
 * easyloader-form.tsx); the workbook `easy-loader-13.xlsx` and its cell map
 * are gone.
 *
 * Coverage, checked against the catalogue's EasyLoader options (2026-09-16
 * dump): the table modules (drive, conveyor, static, busbar, support rail)
 * are the section rows and the total, the roll feed and the paper roll
 * holder have boxes, and so does `Crate-EL`. Nothing an EasyLoader can be
 * sold with reaches the Additional items sheet.
 */
export const easyLoaderSpec: HtmlFormSpec = {
  id: "easyloader",
  title: "EasyLoader Order Form",
  form: "EASYLOADER",
  renderer: "html",
  specSchema: easyLoaderSpecSchema,
  // "ui" is not listed: screenSideSchema defaults to -Y, so it can never be
  // missing. "sections" is not listed either: an empty array legitimately
  // means one undivided table -- see easyLoaderSpecSchema.
  requires: ["usage"],

  covers: ["EL_ROLL_FEED", "EL_ROLL_HOLDER", "CRATE"],
  // The modules have no box of their own: the section rows and the total
  // table length are how the form states them.
  coversOptions: [...EL_MODULE_ROLE_LIST],
};
