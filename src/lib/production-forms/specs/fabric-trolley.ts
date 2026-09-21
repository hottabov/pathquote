import { z } from "zod";
import type { HtmlFormSpec } from "../types";

/**
 * FabricPro Fabric Trolley. Drawn by `FabricTrolleyForm`
 * (src/components/forms/fabric-trolley-form.tsx); the workbook
 * `fabric-trolley-01.xlsx` and its cell map are gone.
 *
 * `FP-TROLLEY` is in the FPT series and prints its own sheet rather than the
 * FabricPro one -- matching is on `Product.form`, which is what that column
 * exists for.
 *
 * Nothing to ask and nothing to tick: the sheet is a header and the quantity,
 * which is always 1 (one item line is one machine, so two trolleys are two
 * lines and two sheets). The catalogue sells no option for a trolley, so
 * `covers` is empty -- and if one is ever added, it surfaces on the
 * Additional items sheet until this form grows a box for it.
 */
export const fabricTrolleySpecSchema = z.object({});

export const fabricTrolleySpec: HtmlFormSpec = {
  id: "fabric-trolley",
  title: "FabricPro Trolley Order Form",
  form: "FP_TROLLEY",
  renderer: "html",
  specSchema: fabricTrolleySpecSchema,
  requires: [],

  covers: [],
};
