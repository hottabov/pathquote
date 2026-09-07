import { z } from "zod";

/** A category's quote copy. Empty is legitimate and stores as `null` so the
 * renderer's `?? ""` and the "prints nothing" path agree. 20000 matches the
 * limit content blocks already use. */
export const seriesQuoteDescriptionSchema = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? null : value),
  z.union([z.null(), z.string().max(20000, "Quote description must be at most 20000 characters")])
);
