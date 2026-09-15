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

/**
 * X-Calibre. The same questions as the M-Series minus the knife: the form
 * prints one size, `2.4 x 8.5 (Std)`, so there is nothing to ask.
 *
 * Provisional, by the owner's note of 2026-09-03: production and the
 * directors have not issued firm specifications for this machine, and the
 * shape is read off the workbook as it stands.
 */
export const xCalibreSpecSchema = z.object({
  ui: screenSideSchema,
  voltage: z.enum(["220V", "400V", "415V", "480V"]).optional(),
  drills: drillsSchema.optional(),
  specialNotes: z.string().trim().optional(),
});

/**
 * L-Series. Three answers the catalogue cannot give, and one it half can.
 *
 * `cuttingLength` and `cuttingSurface` are NOT here: they are facts about
 * the product (`Product.specs.extended` and `.belt` -- `L-320EF` is the
 * extended felt machine), so asking a salesperson to restate them would
 * invite the two to disagree. What is left is what the printed form asks and
 * nothing else knows.
 *
 * The tools row is not here either. Every tool on it is a priced catalogue
 * option carrying role `L_TOOL` (`RKT-28`, `DRV-28`, `NTT`, the punches),
 * and the form's own instruction -- "Replace 'X' with Qty required if more
 * than 1 required" -- is a quantity, which an option line already has. A
 * quantity map in here would be a second place to say the same thing, and
 * the customer pays for these.
 */
export const lSeriesSpecSchema = z.object({
  ui: screenSideSchema,
  /** The printed row is 220/230 or a written-in figure. */
  voltage: z.enum(["220/230", "other"]).optional(),
  voltageOtherVac: z.string().trim().max(20).optional(),
  shipping: z.enum(["complete", "crate-disassembled", "crate-whole"]).optional(),
  specialNotes: z.string().trim().optional(),
}).refine((value) => value.voltage !== "other" || Boolean(value.voltageOtherVac), {
  message: "Specify the voltage",
  path: ["voltageOtherVac"],
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
  /**
   * Whether the table runs in sync with the Pathfinder cutter beside it.
   *
   * Defaults to true: it is how an EasyLoader is normally built, and the
   * owner's instruction is that a manager unticks it in the rare case rather
   * than remembering to tick it every other time. It lives here rather than
   * on the quote because the catalogue has no option for it -- nobody is
   * charged for the synchronisation, but the workshop has to know, which is
   * exactly what `productionSpec` is for.
   */
  syncWithCutter: z.boolean().default(true),
  /**
   * Where each roll feed attachment sits along the table, in millimetres
   * from X=0. Up to four, matching the four printed rows.
   *
   * Only the distances live here. The attachment itself is an option the
   * customer pays for (`EL-2020-RF` / `EL-2420-RF`, role `EL_ROLL_FEED`), so
   * the form's tick and its "Qty." box are read off the option line, not off
   * this spec -- same division as `paperRollHolder` and `crate`, which moved
   * out for the same reason. A distance is the other half: nobody is charged
   * for it, and the service crew fitting the attachment on site is who reads
   * it, so the quote is the only place it can be written down.
   *
   * Jeff, 2026-09-11, on why it cannot be dropped: "some customer might have
   * bigger rolls, and someone have smaller rolls... you can have up to 4
   * different roll holders."
   */
  rollFeedDistancesMm: z.array(z.number().int().min(0).max(99999)).max(4).default([]),
  // `paperRollHolder` and `crate` moved out: they are options the customer
  // pays for, so they belong on the quote's option lines, not here. The form
  // now ticks their boxes from the option codes instead.
});

export const fabricProSpecSchema = z.object({
  ui: screenSideSchema,
  // `travelPlatform` is gone: it is fitted to every FabricPro, so it was a
  // question with one answer (Jeff, 2026-09-11 -- "you're not going to
  // provide it unless there's a FabricPro... every single one's gonna have a
  // travel platform"). The form prints it as a standard; only its length is
  // asked, and that comes from the EasyLoader table anyway (see rails.ts).
  railLengthM: z.number().positive().max(99).optional(),
  powerRailLengthM: z.number().positive().max(99).optional(),
  // `exWorks` is gone too: the delivery term is stated on the quote, and a
  // second copy on a build sheet reads as something the workshop sets
  // (Vadym, 2026-09-11). `crate` is gone as well -- `Crate-FP` is a priced
  // option, so the box is ticked from the option line like every other one.
  // Same split as the EasyLoader's roll feed and paper roll holder.
});

export type MSeriesSpec = z.infer<typeof mSeriesSpecSchema>;
export type XCalibreSpec = z.infer<typeof xCalibreSpecSchema>;
export type LSeriesSpec = z.infer<typeof lSeriesSpecSchema>;
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
