import type { ProductionForm } from "@prisma/client";
import { z } from "zod";
import {
  easyLoaderSpecSchema,
  fabricProSpecSchema,
  lSeriesSpecSchema,
  mSeriesSpecSchema,
  screenSideSchema,
  xCalibreSpecSchema,
} from "@/lib/validation/production-spec";

// What a form's `productionSpec` must look like to be saved, one schema per
// form. Kept apart from the specs themselves (./specs/*) on purpose: the
// specs are read by the builder's client components (which form does this
// item print on, which keys does it still need, does it have a screen side),
// and while each spec carried its schema the whole zod runtime (~380 KB)
// rode into the browser with them (audit 2026-10-16, PERF-08). Only one
// caller validates -- `setProductionSpec` in src/lib/actions/production.ts,
// on the server -- so only it imports this file.

/**
 * The EasyFeeder asks for the screen side and nothing else: no knife, no
 * voltage (always 240 V / 50 Hz, it runs off the cutting machine's supply),
 * no drills. The side is asked so the feeder is not the one machine the
 * customer gets no answer for -- see ./specs/easyfeeder.ts.
 */
export const easyFeederSpecSchema = z.object({
  ui: screenSideSchema,
});

/** Nothing to ask: the Fabric Trolley, the Heavy Duty Roll Feeder and the
 * Leather Nesting System are printed from the quote's lines alone. */
export const fabricTrolleySpecSchema = z.object({});
export const hdrfSpecSchema = z.object({});
export const leatherNestingSpecSchema = z.object({});

const SPEC_SCHEMAS: Record<ProductionForm, z.ZodTypeAny> = {
  M_SERIES: mSeriesSpecSchema,
  EASYLOADER: easyLoaderSpecSchema,
  FABRICPRO: fabricProSpecSchema,
  EASYFEEDER: easyFeederSpecSchema,
  HDRF: hdrfSpecSchema,
  FP_TROLLEY: fabricTrolleySpecSchema,
  LNS: leatherNestingSpecSchema,
  X_CALIBRE: xCalibreSpecSchema,
  L_SERIES: lSeriesSpecSchema,
};

/** The schema `setProductionSpec` validates against, or null for an item
 * with no form (software, services, accessories). */
export function specSchemaForForm(form: ProductionForm | null | undefined): z.ZodTypeAny | null {
  return form ? SPEC_SCHEMAS[form] : null;
}
