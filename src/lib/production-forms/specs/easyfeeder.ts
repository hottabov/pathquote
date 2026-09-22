import { z } from "zod";
import { screenSideSchema } from "@/lib/validation/production-spec";
import type { HtmlFormSpec } from "../types";

/**
 * The EasyFeeder. Drawn by `EasyFeederForm`
 * (src/components/forms/easyfeeder-form.tsx); the workbook
 * `easy-feed-order-form-05.xlsx` and its cell map are gone (2026-09-17).
 *
 * The model is the product: `EF-2020 / 2420 / 3220 / 4030`, the same four
 * widths as the EasyLoader (`Product.specs.tableWidthMm`). Beyond it and the
 * control box side, nothing is asked (Vadym, 2026-09-17):
 * - no voltage -- always 240 V / 50 Hz, and the feeder runs off the cutting
 *   machine it is connected to;
 * - no freight or Ex-Works -- delivery is handled separately.
 *
 * The control box side came back on 2026-09-22 (see `formHasScreenSide`): the
 * quotation now states which side the equipment is built for, and the feeder
 * stands in the same line as the cutter and the EasyLoader, so it has to be
 * asked the same question rather than be the one machine the customer gets no
 * answer for.
 *
 * No option is covered: the catalogue sells none for the EasyFeeder, and
 * anything added anyway goes to the Additional items sheet rather than
 * vanishing.
 */
export const easyFeederSpecSchema = z.object({
  ui: screenSideSchema,
});

export const easyFeederSpec: HtmlFormSpec = {
  id: "easyfeeder",
  title: "EasyFeeder Order Form",
  form: "EASYFEEDER",
  renderer: "html",
  specSchema: easyFeederSpecSchema,
  requires: [],

  covers: [],
};
