import { lSeriesSpecSchema } from "@/lib/validation/production-spec";
import { PATHWORKS_ROLES } from "../pathworks";
import type { HtmlFormSpec } from "../types";

/**
 * L-Series. Rendered as a component for the same reason as the X-Calibre:
 * it has no xlsx implementation and should never grow one. Visual contract:
 * `docs/mockups/l-series-order-form.html`.
 *
 * Three rows of this form are read off the product rather than asked:
 * `Model` from `Product.specs.widthCode` (180 / 220 / 320), `Cutting Length`
 * from `.extended` (175 standard, 316 extended) and `Cutting Surface` from
 * `.belt` (felt or urethane). `L-320EF` is the extended felt machine, so all
 * three come from one code and none of them can contradict the quote.
 *
 * `MRK` is standard on every L-Series -- the form says so in print -- and is
 * also a priced option in the catalogue, compatible with both L and M. It is
 * covered here because the form does have a box for it; what the form also
 * prints, and what nothing enforces yet, is that `MRK` is removed when
 * `IJP`, `JTP` or `ABR` is fitted. Those four are mutually exclusive and
 * belong in an `OptionConflictGroup`.
 */
export const lSeriesSpec: HtmlFormSpec = {
  id: "l-series",
  title: "L-Series Order Form",
  form: "L_SERIES",
  renderer: "html",
  specSchema: lSeriesSpecSchema,
  requires: [],

  // The tools row prints a quantity per tool rather than a tick, and every
  // tool on it is an `L_TOOL` option, so the row is the option lines
  // themselves -- covered here, printed with their quantities.
  covers: [
    "L_TOOL",
    "L_EXTENDED",
    "OFD",
    "OFP",
    "BCR",
    "HDC",
    "PM",
    "ABR",
    "IJP",
    "JTP",
    "APM",
    "PRM",
    "HFV",
    "CRATE",
    "MRK",
    "TRANSFORMER",
    ...PATHWORKS_ROLES,
  ],
};
