import { xCalibreSpecSchema } from "@/lib/validation/production-spec";
import { PATHWORKS_ROLES } from "../pathworks";
import type { HtmlFormSpec } from "../types";

/**
 * X-Calibre. Rendered as a component, not by patching a workbook -- it has
 * never had an xlsx implementation, and writing one now would be work the
 * render spec deletes (docs/superpowers/specs/2026-09-03-web-production-
 * forms-design.md §7.1). The visual contract is
 * `docs/mockups/x-calibre-order-form.html`.
 *
 * The printed form is correct as it stands: the catalogue sells two
 * machines, `X-10180` and `X-10220`, so one `X10` model box and two widths
 * is the whole range. The trimmed X3/X5/X7 rows and the 390 width are gone
 * from the catalogue, not merely unsold.
 *
 * Standard fitment on this machine, printed pre-ticked under "Standard
 * Items": `IKA`, `AFP`, `HFV`. They are not quoted, so they are not in
 * `covers` -- if one ever does arrive as an option line, it belongs on the
 * Additional items sheet where somebody will notice, exactly as `VRB` is
 * handled on the M-Series.
 */
export const xCalibreSpec: HtmlFormSpec = {
  id: "x-calibre",
  title: "X-Calibre Order Form",
  form: "X_CALIBRE",
  renderer: "html",
  specSchema: xCalibreSpecSchema,
  requires: ["drills"],

  // Every X-compatible option in the catalogue has a box (2026-09-16 dump):
  // the selected column, TR220/TR480 in the power column, the crate, MTS
  // with its travel, and the PathWorks section.
  covers: [
    "HDC",
    "BCR",
    "OFJ",
    "OFD",
    "OFP",
    "DR2",
    "PRM",
    "DMT",
    "CRATE",
    "TRANSFORMER",
    "MTS",
    "MTS_TRAVEL",
    ...PATHWORKS_ROLES,
  ],
};
