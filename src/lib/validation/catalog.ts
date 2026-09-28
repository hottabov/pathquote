// Pure zod validation for the catalog admin editors (products, options,
// per-region prices, option/series compatibility). No imports from `@/lib/db`
// or any Prisma types — this module must be safely importable from a plain
// unit test and from the server actions that call it.
import { z } from "zod";

// --- shared field pieces -----------------------------------------------

// The extracted catalog has codes that are far messier than alnum-dash:
// real seeded codes run up to ~90 characters and contain parentheses,
// slashes, commas, and apostrophes (e.g. "Drills included",
// "Waste Bin-180"), and are mixed case rather than a normalized uppercase
// form. Validation is intentionally permissive here — codes are stored
// as-is and uniqueness is enforced by the database, not by this regex.
// Only printable ASCII (no control characters) is required, bounded to a
// generous 120 characters.
const CODE_REGEX = /^[\x20-\x7E]{1,120}$/;

/** Bounds a catalog code (product/option) to 1-120 printable ASCII
 * characters (no tabs/newlines/other control chars) and rejects — rather
 * than silently trims — leading/trailing whitespace, since a code that
 * differs only by invisible padding would be confusing to store and hard
 * to spot in the admin UI. Codes are stored exactly as entered: no case
 * normalization, since real seeded codes are mixed case ("Drills
 * included", "Waste Bin-180") and uniqueness is enforced by the database. */
const codeSchema = z
  .string()
  .regex(CODE_REGEX, {
    message: "Code must be 1-120 printable characters with no control characters",
  })
  .refine((value) => value.trim() === value && value.length > 0, {
    message: "Code must not have leading or trailing whitespace",
  });

const nameSchema = z
  .string()
  .trim()
  .min(2, "Name must be at least 2 characters")
  .max(200, "Name must be at most 200 characters");

/** Optional free text, ≤2000 chars. Missing/empty (incl. "" or null from a
 * FormData.get() on an absent field) collapses to `undefined`. */
const descriptionSchema = z.preprocess(
  (value) =>
    value === null || value === undefined || (typeof value === "string" && value.trim() === "")
      ? undefined
      : value,
  z.string().max(2000, "Description must be at most 2000 characters").optional()
);

/**
 * A checkbox's raw FormData value ("on" when checked, absent/null when
 * unchecked) coerced to a real boolean. Also accepts an actual boolean or
 * "true"/"1" so plain objects (tests, programmatic callers) work the same
 * way as a submitted <form>.
 */
const checkboxBooleanSchema = z.preprocess(
  (value) => value === "on" || value === true || value === "true" || value === "1",
  z.boolean()
);

/** Non-negative integer sort order; missing/empty defaults to 0. */
const sortOrderSchema = z.preprocess(
  (value) => (value === "" || value === null || value === undefined ? 0 : value),
  z.coerce
    .number({ error: "Sort order must be a number" })
    .int("Sort order must be a whole number")
    .min(0, "Sort order must be 0 or greater")
);

// --- product ---------------------------------------------------------------

export const productSchema = z.object({
  code: codeSchema,
  name: nameSchema,
  description: descriptionSchema,
  active: checkboxBooleanSchema,
  // Whether a salesperson earns no commission on this product — same
  // checkbox contract as `active` above. Defaults to false via
  // `checkboxBooleanSchema` itself treating an absent/unchecked box as
  // false, matching the column's own `@default(false)`.
  noCommission: checkboxBooleanSchema,
  sortOrder: sortOrderSchema,
});

export type ProductInput = z.infer<typeof productSchema>;

// --- option ------------------------------------------------------------

const shortDescriptionSchema = z.preprocess(
  (value) =>
    value === null || value === undefined || (typeof value === "string" && value.trim() === "")
      ? undefined
      : value,
  z.string().max(500, "Short description must be at most 500 characters").optional()
);

export const optionSchema = productSchema.extend({
  shortDescription: shortDescriptionSchema,
});

export type OptionInput = z.infer<typeof optionSchema>;

// --- price -----------------------------------------------------------------

const AMOUNT_REGEX = /^\d+(\.\d{1,2})?$/;

export const priceInputSchema = z.object({
  regionCode: z
    .string()
    .trim()
    .transform((value) => value.toUpperCase())
    .refine((value) => /^[A-Z]{2,3}$/.test(value), {
      message: "Region code must be 2-3 letters",
    }),
  // "" is a deliberate signal meaning "clear this price"; anything else
  // must be a non-negative decimal with at most 2 decimal places.
  amount: z
    .string()
    .trim()
    .refine((value) => value === "" || AMOUNT_REGEX.test(value), {
      message: "Amount must be a non-negative number with at most 2 decimal places",
    }),
});

export type PriceInput = z.infer<typeof priceInputSchema>;

// --- max discount cap -----------------------------------------------------

const MAX_DISCOUNT_PCT_REGEX = /^\d{1,3}(\.\d{1,2})?$/;

/**
 * A discount cap percentage: 0..100, at most 2 decimal places, empty means
 * "no cap"/`null`. Originally the per-series `maxDiscountPct` edited on
 * /catalog; discount caps now live on `Region` instead (owner: "USA 15%,
 * Australia 10; don't surface in the catalog" — see `regionFormFields` in
 * validation/regions.ts, which imports and reuses this exact schema rather
 * than duplicating it). `Series.maxDiscountPct` itself is unused now — kept
 * in the schema, not read anywhere. This is a plain 0..100 percentage
 * cap, unrelated to `discountValueSchema`/`discountModeSchema` in
 * validation/documents.ts (Task 6: a *discount* can be a percentage or a
 * fixed cash amount; the *cap* on it is always a percentage, in both
 * cases) — kept as its own schema here rather than a cross-import since
 * the modules happen to need a similarly-shaped percentage field rather
 * than actually depending on each other.
 */
export const maxDiscountPctSchema = z.preprocess(
  (value) =>
    value === null || value === undefined || (typeof value === "string" && value.trim() === "")
      ? null
      : value,
  z.union([
    z.null(),
    z
      .string()
      .trim()
      .regex(MAX_DISCOUNT_PCT_REGEX, "Max discount must be a number between 0 and 100 with at most 2 decimal places")
      .transform((value) => Number(value))
      .refine((value) => value >= 0 && value <= 100, "Max discount must be between 0 and 100"),
  ])
);
export type MaxDiscountPctInput = z.infer<typeof maxDiscountPctSchema>;

/**
 * A markup ceiling percentage: the mirror of `maxDiscountPctSchema` above,
 * for `Region.maxMarkupPct` (Ross: "he's got a minimum selling price. And a
 * maximum selling price. And those rules apply to the LLC as well." — the
 * minimum is the discount cap above, this is the maximum). Same 0..100, at
 * most 2 decimal places, empty-means-no-ceiling shape — kept as its own
 * schema (not a bare alias) purely so its validation messages say "markup",
 * not "discount". */
export const maxMarkupPctSchema = z.preprocess(
  (value) =>
    value === null || value === undefined || (typeof value === "string" && value.trim() === "")
      ? null
      : value,
  z.union([
    z.null(),
    z
      .string()
      .trim()
      .regex(MAX_DISCOUNT_PCT_REGEX, "Max markup must be a number between 0 and 100 with at most 2 decimal places")
      .transform((value) => Number(value))
      .refine((value) => value >= 0 && value <= 100, "Max markup must be between 0 and 100"),
  ])
);
export type MaxMarkupPctInput = z.infer<typeof maxMarkupPctSchema>;

// --- product reordering (drag-and-drop) -------------------------------------

/** The full ordered list of a series' product ids submitted by the
 * /catalog/[seriesId] page's drag-and-drop / up-down reorder UI — same
 * shape and bound as `reorderSchema` in validation/documents.ts (the
 * builder's own item reorder), kept as its own schema here rather than a
 * cross-import: same reasoning `maxDiscountPctSchema`/`maxMarkupPctSchema`
 * above already give — the two modules happen to need an identically-shaped
 * id list, not actually depend on each other. Plain (non-cuid-pattern)
 * strings, matching how every other id this module's actions take
 * (`productId`, `seriesId`, ...) is handled — not validated by shape, just
 * checked against what's actually in the database. The *set* of ids still
 * has to be checked against the series' actual products by the caller (see
 * `isProductPermutation`) since a schema alone can't know what the series
 * holds. */
export const reorderProductsSchema = z
  .array(z.string().min(1), { error: "Invalid order" })
  .min(1, "Invalid order")
  .max(500, "Invalid order")
  .refine((ids) => new Set(ids).size === ids.length, "Duplicate product in order");
export type ReorderProductsInput = z.infer<typeof reorderProductsSchema>;

/** Pure set-equality check — duplicated from `isPermutation` in
 * validation/documents.ts for the same reason `reorderProductsSchema` is a
 * duplicate, not a cross-import. `proposed` must contain exactly the same
 * ids as `actual`, any order; two empty arrays count as a permutation of
 * each other. */
export function isProductPermutation(proposed: string[], actual: string[]): boolean {
  if (proposed.length !== actual.length) return false;
  const proposedSet = new Set(proposed);
  const actualSet = new Set(actual);
  if (proposedSet.size !== proposed.length) return false;
  if (actualSet.size !== actual.length) return false;
  for (const id of proposedSet) {
    if (!actualSet.has(id)) return false;
  }
  return true;
}

// --- compatibility diff -----------------------------------------------------

export type CompatDiff = { toAdd: string[]; toRemove: string[] };

/**
 * Pure helper: given the series codes an option is currently compatible
 * with and the set submitted from the editor, returns which codes need a
 * compatibility row created and which need one removed. No I/O — the
 * caller resolves codes to series ids and writes the rows.
 */
export function compatDiff(current: string[], submitted: string[]): CompatDiff {
  const currentSet = new Set(current);
  const submittedSet = new Set(submitted);
  return {
    toAdd: submitted.filter((code) => !currentSet.has(code)),
    toRemove: current.filter((code) => !submittedSet.has(code)),
  };
}

// --- option conflict groups ----------------------------------------------

/**
 * An `OptionConflictGroup.name` -- e.g. "Knife tools -- fit one only". Same
 * bounds as `nameSchema` above (trimmed, 2-200 chars); kept as its own
 * export (rather than reusing the private `nameSchema`) since a conflict
 * group is administered from its own settings screens
 * (`/settings/option-conflict-groups`), not the product/option editors this
 * module's other schemas back.
 */
export const conflictGroupNameSchema = z
  .string()
  .trim()
  .min(2, "Name must be at least 2 characters")
  .max(200, "Name must be at most 200 characters");

export type ConflictGroupNameInput = z.infer<typeof conflictGroupNameSchema>;
