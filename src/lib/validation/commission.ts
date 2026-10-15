// Pure zod validation for a user's commission table (Settings -> Users ->
// <user> -> Commission). No database imports, same style as its siblings.
import { z } from "zod";
import { type CommissionTier, validateCommissionTiers } from "@/lib/pricing";

/** One row of the commission-rate table, as submitted by
 * `CommissionTiersForm`'s hidden JSON input — structurally the same shape
 * as `CommissionTier` (src/lib/pricing.ts), kept as its own schema (rather
 * than a runtime cast) so a malformed row is a normal validation error, not
 * a crash inside `validateCommissionTiers`. */
const commissionTierRowSchema = z.object({
  minPct: z.number().finite(),
  maxPct: z.number().finite().nullable(),
  ratePct: z.number().finite(),
});

/** Raw JSON text from `CommissionTiersForm`'s hidden input (saved to
 * `User.commissionTiers` by `setUserCommissionTiers`) — parsed, checked
 * against `commissionTierRowSchema` row by row, and then run through
 * `validateCommissionTiers` (src/lib/pricing.ts) for the cross-row rules
 * (starts at 0%, no gap, no overlap) a per-row schema can't express on its
 * own. Mirrors `bankDetailsSchema`'s (src/lib/validation/regions.ts) JSON-
 * text-then-parse-then-validate shape. An empty array is valid — see
 * `validateCommissionTiers`'s doc comment for why clearing the table is a
 * deliberately supported state, not an error. */
export const commissionTiersSchema = z
  .string()
  .transform((value, ctx) => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      ctx.addIssue({ code: "custom", message: "Commission tiers must be valid JSON" });
      return z.NEVER;
    }
    const result = z.array(commissionTierRowSchema).safeParse(parsed);
    if (!result.success) {
      ctx.addIssue({
        code: "custom",
        message: result.error.issues[0]?.message ?? "Invalid commission tiers",
      });
      return z.NEVER;
    }
    return result.data;
  })
  .superRefine((tiers, ctx) => {
    const error = validateCommissionTiers(tiers);
    if (error) ctx.addIssue({ code: "custom", message: error });
  });
export type CommissionTiersInput = CommissionTier[];
