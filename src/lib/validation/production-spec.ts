import { z } from "zod";
import { MAX_SECTIONS } from "../production-forms/table-sections";

/**
 * Operator-screen side. Shared by every machine that has one, because a
 * cutter and its spreaders usually agree, though not always -- see
 * `setProductionSpec` for why applying one side to the rest of the quote is
 * offered rather than done.
 * Defaults to `-Y` -- material running right to left -- which the M-Series
 * form already prints as `(STD)`, so a manager who never opens the
 * production-spec panel still gets the correct standard rather than a blank
 * box on the form.
 */
export const screenSideSchema = z.enum(["+Y", "-Y"]).default("-Y");

/**
 * Drills. The printed form says `"TBC" is not acceptable`, so "required with
 * no detail" is not a valid state -- either there are no drills, or their
 * quantity, type and size are written down.
 */
export const drillsSchema = z
  .object({
    required: z.boolean(),
    detail: z.string().trim().max(22, "Drill detail must be 22 characters or fewer"),
  })
  .refine((value) => !value.required || value.detail.length > 0, {
    message: "Specify drill quantity, type and size",
    path: ["detail"],
  });

/**
 * These schemas describe a spec *being filled in*, not a finished one, so
 * every answer is optional even where the form insists on it. That is not a
 * relaxation of the rules -- it is where they live. `ProductionSpecEditor`
 * has no Save button: each control spreads the value that just changed over
 * the spec already stored and writes the result, so on an item whose
 * `productionSpec` column is still null the first field a manager touches
 * arrives entirely on its own. Requiring a whole object here made that first
 * write impossible ("expected object, received undefined" for the absent
 * `drills`), which is to say it made the panel unusable on exactly the items
 * it exists for.
 *
 * What a completed spec must contain is `FormSpec.requires`, checked by
 * `missingKeys` below -- the same check that greys out the download button
 * and that the form route answers 422 on. One gate, at the point where the
 * spec is printed rather than at every keystroke on the way there.
 *
 * Nothing gains a default in place of being required, either: `missingKeys`
 * reads `drills: { required: false }` as asked-and-answered, so a default
 * would tell the workshop a question had been put to the customer that
 * never was.
 */

/**
 * The two free-text areas on the M-Series form are tall single rows with no
 * empty cells to their right, so text cannot overflow the way an address
 * line does -- it would simply be clipped. Hence the hard caps.
 */
export const mSeriesSpecSchema = z.object({
  ui: screenSideSchema,
  knifeSize: z.enum(["1.5x5.0", "1.5x7.0", "2.0x7.0"]).optional(),
  voltage: z.enum(["220V", "400V", "415V", "480V"]).optional(),
  drills: drillsSchema.optional(),
  specialNotes: z.string().trim().max(28, "Special notes must be 28 characters or fewer").optional(),
});

export const easyLoaderSpecSchema = z.object({
  ui: screenSideSchema,
  usage: z.enum(["onload", "offload"]).default("onload"),
  customWidthMm: z.number().int().positive().max(9999).optional(),
  // The table's physical layout, and now the thing the EasyLoader's option
  // lines are computed from rather than checked against -- see
  // `deriveEasyLoaderOptions`. An empty array is a table with no modules,
  // which prices at nothing; the machine itself costs nothing, because every
  // part of it is one of these.
  sections: z
    .array(z.object({ lengthM: z.number().positive().max(99), surface: z.enum(["static", "conveyor"]) }))
    .max(MAX_SECTIONS)
    .default([]),
  /** Adds the electrical busbar and the travel-platform support rail, one of
   * each per 1.2m module, so a FabricPro can run the length of this table. */
  fabricProCompatible: z.boolean().default(false),
  rollFeed: z
    .object({ qty: z.number().int().min(1).max(4), distancesMm: z.array(z.number().int().min(0)).max(4) })
    .optional(),
  // `paperRollHolder` and `crate` moved out: they are options the customer
  // pays for, so they belong on the quote's option lines, not here. The form
  // now ticks their boxes from the option codes instead.
});

export const fabricProSpecSchema = z.object({
  ui: screenSideSchema,
  // Optional for the reason given above the M-Series schema: the rail
  // lengths and the screen side sit either side of this checkbox in the
  // panel, and whichever a manager reaches for first is saved without it.
  travelPlatform: z.boolean().optional(),
  railLengthM: z.number().positive().max(99).optional(),
  powerRailLengthM: z.number().positive().max(99).optional(),
  exWorks: z.boolean().optional(),
  crate: z.boolean().optional(),
});

export type MSeriesSpec = z.infer<typeof mSeriesSpecSchema>;
export type EasyLoaderSpec = z.infer<typeof easyLoaderSpecSchema>;
export type FabricProSpec = z.infer<typeof fabricProSpecSchema>;

/**
 * Which of a form's `requires` keys are not yet answered. Drives both the
 * disabled download button and the 422 the route returns, so the UI and the
 * server can never disagree about what is missing.
 *
 * Two keys need more than a presence check: `drills` is satisfied by an
 * explicit "no drills", and `sections` is not satisfied by an empty array.
 */
export function missingKeys(spec: unknown, required: string[]): string[] {
  const record = (spec ?? {}) as Record<string, unknown>;

  return required.filter((key) => {
    const value = record[key];
    if (value === undefined || value === null) return true;

    if (key === "drills") {
      const drills = value as { required?: boolean; detail?: string };
      if (drills.required === false) return false;
      return !drills.detail || drills.detail.trim().length === 0;
    }

    if (Array.isArray(value)) return value.length === 0;
    if (typeof value === "string") return value.trim().length === 0;

    return false;
  });
}
