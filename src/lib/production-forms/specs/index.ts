import type { FormSpec } from "../types";
import { mSeriesSpec } from "./m-series";
import { easyLoaderSpec } from "./easyloader";
import { fabricProSpec } from "./fabricpro";
import { easyFeederSpec } from "./easyfeeder";
import { hdrfSpec } from "./hdrf";
import { fabricTrolleySpec } from "./fabric-trolley";
import { leatherNestingSpec } from "./leather-nesting";
import { xCalibreSpec } from "./x-calibre";
import { lSeriesSpec } from "./l-series";

/** Order is irrelevant: matching is by `Product.form` and pages follow item sortOrder. */
export const FORM_SPECS: FormSpec[] = [
  mSeriesSpec,
  easyLoaderSpec,
  fabricProSpec,
  easyFeederSpec,
  hdrfSpec,
  fabricTrolleySpec,
  leatherNestingSpec,
  xCalibreSpec,
  lSeriesSpec,
];
