import { mSeriesSpecSchema } from "@/lib/validation/production-spec";
import { PATHWORKS_ROLES } from "../pathworks";
import type { HtmlFormSpec } from "../types";

/**
 * M-Series. Drawn by `MSeriesForm` (src/components/forms/m-series-form.tsx);
 * the workbook it was first patched into (`m-series-order-12.xlsx`) is gone,
 * cell map and all -- the form owes nothing to Excel any more.
 *
 * `covers` is every option role the form prints a box for, and it was
 * checked against the catalogue's M-compatible options (2026-09-16 dump):
 * each one has a box, so a fully optioned M-Series sends nothing to the
 * Additional items sheet. The only box with no catalogue option behind it is
 * `VRB`, fitted to every machine and printed as standard -- deliberately NOT
 * covered: if a VRB line ever appears on a quote, something has changed and
 * it belongs on the Additional items sheet where somebody will see it.
 */
export const mSeriesSpec: HtmlFormSpec = {
  id: "m-series",
  title: "M-Series Order Form",
  form: "M_SERIES",
  renderer: "html",
  specSchema: mSeriesSpecSchema,
  // "ui" is not listed: screenSideSchema defaults to -Y, so it can never be
  // missing -- leaving it here would permanently disable the download button
  // for any spec stored before that default existed.
  requires: ["knifeSize", "drills"],

  covers: [
    "OFJ",
    "HFV",
    "PM",
    "OFD",
    "PRM",
    "APM",
    "OFP",
    "DMT",
    "DRG_1",
    "DRG_2",
    "DRG_3",
    "MRK",
    "IJP",
    "IKA",
    "ABR",
    "AFP",
    "DR2",
    "HDC",
    "BCR",
    "CRATE",
    // TR220 and TR480 each have a box in the power row; any other
    // transformer the catalogue gains prints beside them under its own code.
    "TRANSFORMER",
    "MTS",
    // The per-metre travel is the MTS block's figure, not a separate box.
    "MTS_TRAVEL",
    ...PATHWORKS_ROLES,
  ],
};
