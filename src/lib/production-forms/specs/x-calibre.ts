import { xCalibreSpecSchema } from "@/lib/validation/production-spec";
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

  // The option boxes the printed form has, left to right down its three
  // columns. Notably absent, and deliberately so: `DMT`, which the catalogue
  // marks compatible with the X series but which this form has no box for.
  // Until the form gains one, a DuctMasTer sold on an X-Calibre prints on
  // the Additional items sheet rather than disappearing.
  covers: ["HDC", "BCR", "OFJ", "OFD", "OFP", "DR2", "PRM", "CRATE", "MTS", "MTS_TRAVEL"],
};
