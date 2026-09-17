import { z } from "zod";
import type { HtmlFormSpec } from "../types";

/**
 * The EasyFeeder. Drawn by `EasyFeedForm`
 * (src/components/forms/easyfeed-form.tsx); the workbook
 * `easy-feed-order-form-05.xlsx` and its cell map are gone (2026-09-17).
 *
 * The only choice on the sheet is the model, and the model is the product:
 * `EF-2020 / 2420 / 3220 / 4030`, the same four widths as the EasyLoader
 * (`Product.specs.tableWidthMm`). Nothing else is asked (Vadym, 2026-09-17):
 * - no voltage -- always 240 V / 50 Hz, and the feeder runs off the cutting
 *   machine it is connected to;
 * - no control box side -- see `formHasScreenSide`;
 * - no freight or Ex-Works -- delivery is handled separately.
 *
 * No option is covered: the catalogue sells none for the EasyFeeder, and
 * anything added anyway goes to the Additional items sheet rather than
 * vanishing.
 */
export const easyFeedSpecSchema = z.object({});

export const easyFeedSpec: HtmlFormSpec = {
  id: "easyfeed",
  title: "EasyFeed Order Form",
  form: "EASYFEED",
  renderer: "html",
  specSchema: easyFeedSpecSchema,
  requires: [],

  covers: [],
};
