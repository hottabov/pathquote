import { z } from "zod";
import type { HtmlFormSpec } from "../types";

/**
 * The Heavy Duty Roll Feeder. Drawn by `HdrfForm`
 * (src/components/forms/hdrf-form.tsx); the workbook `hdrf-01.xlsx` and its
 * cell map are gone (2026-09-17).
 *
 * The sheet asks two things: the model, which is the product itself
 * (`HDRF-180/220/320`, `Product.specs.widthCode`), and the crate, which is
 * the priced option sold with it -- `Crate-HDRF-180/220/320`, one per model,
 * all `role: CRATE`. Nothing is asked of the manager, so the spec is empty
 * and nothing is required.
 */
export const hdrfSpecSchema = z.object({});

export const hdrfSpec: HtmlFormSpec = {
  id: "hdrf",
  title: "HDRF Order Form",
  form: "HDRF",
  renderer: "html",
  specSchema: hdrfSpecSchema,
  requires: [],

  covers: ["CRATE"],
};
