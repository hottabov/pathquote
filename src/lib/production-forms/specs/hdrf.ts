import { z } from "zod";
import type { FormContext, FormSpec } from "../types";
import { crateTick, machineSaleHeader } from "./shared-header";

/**
 * The Heavy Duty Roll Feeder. One row of three model boxes and a crate --
 * the shortest form Pathfinder prints.
 *
 * HDRF lives in the `EF` series beside the EasyFeeder but has its own form,
 * which is the case that made matching on `Product.form` rather than on the
 * series necessary in the first place.
 *
 * The third box's label sits in N28 rather than O28 (and reads "HDRF 320",
 * with a stray space), so its box is M28 and not the narrow column the other
 * two use. That is the sheet's own inconsistency, confirmed by eye against a
 * rendered page, not a transcription slip.
 */
const PRINTED_WIDTH: Record<number, string> = { 180: "H28", 220: "J28", 320: "M28" };

export const hdrfSpecSchema = z.object({});

export const hdrfSpec: FormSpec = {
  id: "hdrf",
  title: "HDRF Order Form",
  renderer: "xlsx",
  template: "hdrf-01.xlsx",
  sheetPath: "xl/worksheets/sheet1.xml",
  form: "HDRF",
  specSchema: hdrfSpecSchema,
  requires: [],

  values: [...machineSaleHeader()],
  replaces: [],

  ticks: [
    ...Object.entries(PRINTED_WIDTH).map(([widthCode, cell]) => ({
      cell,
      when: (c: FormContext) => c.item.specs.widthCode === Number(widthCode),
    })),
    crateTick("D45"),
  ],
};
