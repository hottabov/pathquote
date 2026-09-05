import { z } from "zod";

/**
 * The shape of `Product.specs` -- the physical facts about a product that
 * the quotation spec sentence (src/lib/machine-specs.ts), the order forms'
 * model/width boxes (src/lib/production-forms/specs/*) and the EasyLoader
 * form's printed-width box read.
 *
 * Every field is optional: an accessory has none of them, a cutter has
 * height and width, a table has a width in millimetres. What a product
 * *needs* here is decided by its kind (`requiredSpecKeys`), not by this
 * schema, so a product with a missing figure stays saveable -- it just
 * prints a blank where the figure would go, the same degradation the code
 * parsers had for a code they did not recognise.
 *
 * This replaces reading the figures out of the code. The owner's domain
 * rule that "the code encodes the spec" still holds for how codes are
 * *chosen* (M-3180 is a 3cm × 180cm machine), but the app no longer
 * re-derives it: a code is a label, this is the fact.
 */
export const productSpecsSchema = z
  .object({
    /** Compressed lay height, cm. M / X series. */
    cutHeightCm: z.number().positive().optional(),
    /** Cutting width, cm. M / X / L series, FabricPro (spread width). */
    cutWidthCm: z.number().positive().optional(),
    /** Table width, mm. EasyLoader, EasyFeeder. */
    tableWidthMm: z.number().int().positive().optional(),
    /** Paper width, mm. Punchline. */
    paperWidthMm: z.number().int().positive().optional(),
    /**
     * Model tier printed on the M-Series form's model row: "M3" | "M5" |
     * "M7" | "M10" (X-Calibre prints on the same form with its own tier,
     * "X10"). Kept as a string because the form's row is a set of named
     * boxes, not a number line.
     */
    modelTier: z.string().min(1).optional(),
    /**
     * The width family a cutter belongs to, as the price lists and the
     * order forms name it: 180 | 220 | 300 | 390. Distinct from
     * `cutWidthCm` because a "220" machine cuts 227cm (and an L "220" cuts
     * 226cm) -- the form ticks the family box, the quotation prints the
     * real figure.
     */
    widthCode: z.number().int().positive().optional(),
    /** L-Series extended length variant. */
    extended: z.boolean().optional(),
    /** L-Series cutting belt. */
    belt: z.enum(["urethane", "felt"]).optional(),
    /** PathWorks: sold standalone or integrated into PathCut. */
    softwareMode: z.enum(["standalone", "integrated"]).optional(),
    /**
     * Which PathWorks module box this software product ticks on the
     * M-Series form (rows 62-64). Only the five modules the form prints.
     */
    pathworksModule: z.enum(["PDG", "WPN", "WPL", "ANT_V5", "ANT_V6"]).optional(),
  })
  .strict();

export type ProductSpecs = z.infer<typeof productSpecsSchema>;

/**
 * Reads `Product.specs` defensively: a null column, a pre-migration blob
 * or a hand-edited one that fails validation all read as "no specs" rather
 * than throwing inside a render.
 */
export function readProductSpecs(raw: unknown): ProductSpecs {
  const parsed = productSpecsSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : {};
}
