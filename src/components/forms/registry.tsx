import type { ProductionForm } from "@prisma/client";
import type { ReactElement } from "react";
import type { FormContext } from "@/lib/production-forms/types";
import { MSeriesForm } from "./m-series-form";
import { XCalibreForm } from "./x-calibre-form";
import { EasyLoaderForm } from "./easyloader-form";
import { FabricProForm } from "./fabricpro-form";
import { LSeriesForm } from "./l-series-form";
import { HdrfForm } from "./hdrf-form";
import { EasyFeedForm } from "./easyfeed-form";

/**
 * Which component draws which form.
 *
 * Deliberately separate from `FORM_SPECS` (src/lib/production-forms/specs):
 * that registry is the declarative half -- matching, coverage, the
 * `productionSpec` schema -- and is imported by server code and by the
 * builder alike. This one pulls in JSX, so keeping the two apart stops a
 * React component from being dragged into every module that only wanted to
 * ask which form a product prints on.
 *
 * A form declared `renderer: "html"` with no entry here is not renderable
 * yet, and the PDF route blocks it by name rather than omitting its page.
 */
const COMPONENTS: Partial<Record<ProductionForm, (props: { ctx: FormContext }) => ReactElement>> = {
  M_SERIES: MSeriesForm,
  X_CALIBRE: XCalibreForm,
  EASYLOADER: EasyLoaderForm,
  FABRICPRO: FabricProForm,
  L_SERIES: LSeriesForm,
  HDRF: HdrfForm,
  EASYFEED: EasyFeedForm,
};

/** The component for a form, or null when it has not been built yet. */
export function formComponent(form: ProductionForm) {
  return COMPONENTS[form] ?? null;
}

/** Which forms can actually be drawn today. */
export function isRenderable(form: ProductionForm): boolean {
  return formComponent(form) !== null;
}
