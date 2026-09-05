// Pure zod validation for the app-settings editor (main /settings page). No
// imports from `@/lib/db` or any Prisma types — mirrors the style of
// src/lib/validation/users.ts and src/lib/validation/regions.ts.
import { z } from "zod";
import { type CommissionTier, validateCommissionTiers } from "@/lib/pricing";
import { validityDayCountSchema } from "./validity-days";

/** Keys `updateSetting` (src/lib/actions/settings.ts) is allowed to write.
 * Kept as an array (rather than inlining string literals at each call site)
 * so a new setting only needs adding here plus a new schema/case in the
 * action's switch. */
export const ALLOWED_SETTING_KEYS = ["quote.validityDays", "ui.showOptionIcons", "commission.tiers"] as const;
export type SettingKey = (typeof ALLOWED_SETTING_KEYS)[number];

export function isAllowedSettingKey(key: string): key is SettingKey {
  return (ALLOWED_SETTING_KEYS as readonly string[]).includes(key);
}

/** Number of days a finalized QUOTE stays valid for, read by
 * `getQuoteValidityDays` (src/lib/queries/settings.ts). A whole number of
 * days from 1 to 365 inclusive; the default of 7 (used when no `Setting` row
 * exists yet) lives with that query, not here. */
export const quoteValidityDaysSchema = validityDayCountSchema({
  invalidType: "Quote validity must be a number",
  notInteger: "Quote validity must be a whole number",
  tooSmall: "Quote validity must be at least 1 day",
  tooLarge: "Quote validity must be at most 365 days",
});
export type QuoteValidityDaysInput = z.infer<typeof quoteValidityDaysSchema>;

/** Whether the builder's options editor shows each compatible option's small
 * icon (read by `getShowOptionIcons`, src/lib/queries/settings.ts; default
 * true when unset). The setting form (mirroring `QuoteValidityForm`) submits
 * this as the literal string "true"/"false" via `FormData`, not a checkbox's
 * native on/absent encoding — `z.coerce.boolean()` would treat the string
 * "false" as truthy, so this validates the two literal strings explicitly. */
export const showOptionIconsSchema = z
  .enum(["true", "false"], { error: "Invalid value" })
  .transform((value) => value === "true");
export type ShowOptionIconsInput = z.infer<typeof showOptionIconsSchema>;

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

/** Raw JSON text from `CommissionTiersForm`'s hidden input (read by
 * `getCommissionTiers`, src/lib/queries/settings.ts) — parsed, checked
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
