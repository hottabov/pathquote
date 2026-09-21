import { z } from "zod";
import type { HtmlFormSpec } from "../types";

/**
 * Leather Nesting System. Drawn by `LeatherNestingForm`
 * (src/components/forms/leather-nesting-form.tsx); the workbook
 * `leather-nesting-station-01.xlsx` and its cell map are gone.
 *
 * The sheet asks nothing (Jeff: "I will leave it by default"): an LNS is one
 * fixed system -- static table, operator console, computer, camera, and the
 * standalone PathWorks with ANT-V6 and the Hide Wizard -- and the only thing
 * that varies is the table width, which the product code already says
 * (`LNS-2420`). So there is no production spec and nothing to tick.
 *
 * The catalogue sells no option for an LNS, so `covers` is empty; one added
 * later surfaces on the Additional items sheet until this form has a box.
 */
export const leatherNestingSpecSchema = z.object({});

export const leatherNestingSpec: HtmlFormSpec = {
  id: "leather-nesting",
  title: "Leather Nesting System Order Form",
  form: "LNS",
  renderer: "html",
  specSchema: leatherNestingSpecSchema,
  requires: [],

  covers: [],
};
