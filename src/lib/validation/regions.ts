// Pure zod validation for the region administration screens
// (/settings/regions). No imports from `@/lib/db`, `@prisma/client`, or any
// Prisma-generated types — this module must be safely importable from a
// plain unit test and from the server actions that call it (see
// src/lib/actions/regions.ts). Mirrors the style of
// src/lib/validation/users.ts and src/lib/validation/catalog.ts.
import { z } from "zod";
import { maxDiscountPctSchema, maxMarkupPctSchema } from "./catalog";
import { regionCodeSchema } from "./region-code";

// --- field pieces ----------------------------------------------------------

/** A region's `code`. Immutable after create: `updateRegionSchema` below
 * deliberately has no `code` field at all, and the edit form renders it
 * read-only. Re-exported from ./region-code so this module's importers are
 * undisturbed by the rule having moved. */
export { regionCodeSchema };

/** ISO-4217-shaped currency code — exactly 3 letters, normalized to
 * uppercase (AUD, USD, GBP...). Not validated against a real currency list;
 * that's an admin-trust boundary the same way catalog codes are. */
export const currencyCodeSchema = z
  .string()
  .trim()
  .transform((value) => value.toUpperCase())
  .refine((value) => /^[A-Z]{3}$/.test(value), {
    message: "Currency must be exactly 3 letters",
  });

export const regionNameSchema = z
  .string()
  .trim()
  .min(2, "Name must be at least 2 characters")
  .max(200, "Name must be at most 200 characters");

export const taxNameSchema = z
  .string()
  .trim()
  .min(1, "Tax name is required")
  .max(40, "Tax name must be at most 40 characters");

/** Matches Region.taxRate's `Decimal(5,2)` column: a non-negative number
 * with at most 2 decimal places, bounded to 0..99.99 inclusive. Kept as a
 * string (like `priceInputSchema.amount` in src/lib/validation/catalog.ts)
 * so the caller can hand it straight to `new Prisma.Decimal(...)` without an
 * intermediate float round-trip. */
const TAX_RATE_REGEX = /^\d{1,3}(\.\d{1,2})?$/;
export const taxRateSchema = z
  .string()
  .trim()
  .refine((value) => TAX_RATE_REGEX.test(value), {
    message: "Tax rate must be a non-negative number with at most 2 decimal places",
  })
  .refine((value) => Number(value) <= 99.99, {
    message: "Tax rate must be between 0 and 99.99",
  });

export const entityNameSchema = z
  .string()
  .trim()
  .min(1, "Entity name is required")
  .max(200, "Entity name must be at most 200 characters");

/** Missing/blank collapses to `undefined` — same preprocess pattern as every
 * other optional-text field in this app (see `descriptionSchema` in
 * src/lib/validation/catalog.ts). */
function optionalTextSchema(max: number, message: string) {
  return z.preprocess(
    (value) =>
      value === null || value === undefined || (typeof value === "string" && value.trim() === "")
        ? undefined
        : value,
    z.string().trim().max(max, message).optional()
  );
}

export const entityLegalIdSchema = optionalTextSchema(100, "Entity legal ID must be at most 100 characters");
export const entityAddressSchema = optionalTextSchema(400, "Entity address must be at most 400 characters");
export const footerTextSchema = optionalTextSchema(2000, "Footer text must be at most 2000 characters");

/** A checkbox's raw FormData value ("on" when checked, absent/null when
 * unchecked) coerced to a real boolean — mirrors `checkboxBooleanSchema` in
 * src/lib/validation/catalog.ts. */
const activeSchema = z.preprocess(
  (value) => value === "on" || value === true || value === "true" || value === "1",
  z.boolean()
);

// --- bank details (dynamic key-value editor) --------------------------------

const BANK_DETAILS_MAX_KEYS = 12;
const BANK_DETAILS_KEY_MAX = 40;
const BANK_DETAILS_VALUE_MAX = 120;

/** A flat string->string record, bounded per the phase-7 spec: at most 12
 * rows, each key 1-40 chars and each value ≤120 chars. Pure structural
 * validation — the JSON parsing that produces this record lives in
 * `bankDetailsSchema` below. */
export const bankDetailsRecordSchema = z
  .record(z.string(), z.string())
  .refine((obj) => Object.keys(obj).length <= BANK_DETAILS_MAX_KEYS, {
    message: `At most ${BANK_DETAILS_MAX_KEYS} bank detail rows are allowed`,
  })
  .refine((obj) => Object.keys(obj).every((key) => key.length >= 1 && key.length <= BANK_DETAILS_KEY_MAX), {
    message: `Each label must be 1-${BANK_DETAILS_KEY_MAX} characters`,
  })
  .refine((obj) => Object.values(obj).every((value) => value.length <= BANK_DETAILS_VALUE_MAX), {
    message: `Each value must be at most ${BANK_DETAILS_VALUE_MAX} characters`,
  });
export type BankDetailsRecord = z.infer<typeof bankDetailsRecordSchema>;

/** Raw JSON text from the dynamic key-value editor's hidden input (see
 * src/components/regions/bank-details-editor.tsx), parsed and validated as a
 * flat string->string record. Empty/blank input becomes `null` (no bank
 * details stored) — mirrors `attributeSchemaSchema` in
 * src/lib/validation/catalog.ts. */
export const bankDetailsSchema = z
  .string()
  .nullish()
  .transform((value) => {
    const trimmed = typeof value === "string" ? value.trim() : "";
    return trimmed === "" ? null : trimmed;
  })
  .transform((value, ctx) => {
    if (value === null) return null;
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      ctx.addIssue({ code: "custom", message: "Bank details must be valid JSON" });
      return z.NEVER;
    }
    const result = bankDetailsRecordSchema.safeParse(parsed);
    if (!result.success) {
      ctx.addIssue({
        code: "custom",
        message: result.error.issues[0]?.message ?? "Invalid bank details",
      });
      return z.NEVER;
    }
    return result.data;
  });

// --- forms -------------------------------------------------------------

/** Fields shared by create and update — everything except `code`, which is
 * only ever set at create time. */
const regionFormFields = {
  name: regionNameSchema,
  currency: currencyCodeSchema,
  taxName: taxNameSchema,
  taxRate: taxRateSchema,
  entityName: entityNameSchema,
  entityLegalId: entityLegalIdSchema,
  entityAddress: entityAddressSchema,
  footerText: footerTextSchema,
  bankDetails: bankDetailsSchema,
  // Region-level discount cap (owner: "USA 15%, Australia 10; don't surface
  // in the catalog") -- same 0..100, ≤2dp, empty-means-no-cap shape as the
  // old series-level cap, so this reuses `maxDiscountPctSchema` from
  // validation/catalog.ts rather than duplicating it.
  maxDiscountPct: maxDiscountPctSchema,
  // The mirror of maxDiscountPct above: how far ABOVE list a distributor may
  // price (Ross: "he's got a minimum selling price. And a maximum selling
  // price."). Same 0..100, ≤2dp, empty-means-no-ceiling shape.
  maxMarkupPct: maxMarkupPctSchema,
  active: activeSchema,
};

export const createRegionSchema = z.object({
  code: regionCodeSchema,
  ...regionFormFields,
});
export type CreateRegionInput = z.infer<typeof createRegionSchema>;

export const updateRegionSchema = z.object(regionFormFields);
export type UpdateRegionInput = z.infer<typeof updateRegionSchema>;
