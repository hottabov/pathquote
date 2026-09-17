import { z } from "zod";
import type { FormContext, FormSpec } from "../types";
import { crateTick, machineSaleHeader } from "./shared-header";

/**
 * Punchline. Two models, one voltage, freight and a crate.
 *
 * **The catalogue has no Punchline products yet** -- no `P` series, no
 * `P-180` / `P-220`. The form is built now because it costs one file and the
 * engine is already here; it simply never matches until someone adds those
 * products with `form: PUNCHLINE` and `specs.widthCode` of 180 or 220. A
 * product added without that spec ticks no model box, which is why the
 * catalogue work is written down rather than left to be noticed on a
 * printed page.
 */
const PRINTED_WIDTH: Record<number, string> = { 180: "H28", 220: "J28" };

export const punchlineSpecSchema = z.object({});

export const punchlineSpec: FormSpec = {
  id: "punchline",
  title: "Punchline Order Form",
  renderer: "xlsx",
  template: "punchline-order-form-05.xlsx",
  sheetPath: "xl/worksheets/sheet1.xml",
  form: "PUNCHLINE",
  specSchema: punchlineSpecSchema,
  requires: [],

  values: [...machineSaleHeader()],
  replaces: [],

  ticks: [
    ...Object.entries(PRINTED_WIDTH).map(([widthCode, cell]) => ({
      cell,
      when: (c: FormContext) => c.item.specs.widthCode === Number(widthCode),
    })),
    // Voltage (H36) is pre-ticked on the template at 220/240V, the only one
    // offered. Ex-Works and the crate are Ricky's rows, not Jeff's.
    // D46 (Ex-Works) is left blank: delivery terms belong to logistics,
    // not to a workshop sheet (Vadym, 2026-09-16).
    crateTick("D58"),
  ],
};
