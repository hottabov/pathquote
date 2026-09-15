import { z } from "zod";
import type { FormSpec } from "../types";
import { machineSaleHeader } from "./shared-header";

/**
 * FabricPro Fabric Trolley. The whole form is a header and one number.
 *
 * `FP-TROLLEY` is in the FabricPro series but does not print the FabricPro
 * form -- it has always had its own sheet, which is the second case (after
 * HDRF inside the EF series) for keying the match on `Product.form`.
 *
 * The quantity is always 1 because a `DocumentItem` has no quantity: one item
 * is one machine, and two trolleys are two items and therefore two sheets.
 * That is the same rule every other form here follows, so it is stated as a
 * constant rather than smuggled in as a blank someone has to fill.
 */
export const fabricTrolleySpecSchema = z.object({});

export const fabricTrolleySpec: FormSpec = {
  id: "fabric-trolley",
  title: "FabricPro Trolley Order Form",
  renderer: "xlsx",
  template: "fabric-trolley-01.xlsx",
  sheetPath: "xl/worksheets/sheet1.xml",
  form: "FP_TROLLEY",
  specSchema: fabricTrolleySpecSchema,
  requires: [],

  values: [...machineSaleHeader(), { cell: "H28", from: () => 1 }],
  replaces: [],
  ticks: [],
};
