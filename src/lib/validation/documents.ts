// Pure zod validation for the document builder (Phase 4 Task C). No imports
// from `@/lib/db` or any Prisma types — this module must be safely
// importable from a plain unit test and from the server actions that call
// it. Mirrors the style of src/lib/validation/clients.ts. `@/lib/uploads` is
// safe to import here too (see `customLineSchema.imageUrl` below): it's a
// pure fs/path/crypto module with the same no-db/no-next discipline.
import { z } from "zod";
import { IMAGE_URL_PATTERN } from "@/lib/uploads";
import { validityDayCountSchema } from "./validity-days";

/** Every id in this app is a Prisma `cuid()` — 25 lowercase base36
 * characters starting with "c". We don't couple to that exact alphabet
 * (tests use handwritten fixture ids too), just to a plausible length, so a
 * stray empty string or an obviously-wrong value (e.g. a raw name) is
 * rejected before it ever reaches a database query. */
export const idSchema = z
  .string()
  .trim()
  .min(10, "Invalid id")
  .max(40, "Invalid id");

/** Optional variant of idSchema: missing/blank/`null` collapses to
 * `undefined` (used for `contactId?` on setDocumentClient — an absent
 * contact isn't an error, it tells the action to auto-assign the company's
 * primary contact instead of failing validation). */
export const optionalIdSchema = z.preprocess(
  (value) =>
    value === null || value === undefined || (typeof value === "string" && value.trim() === "")
      ? undefined
      : value,
  idSchema.optional()
);

// --- Task D: options, custom lines, discounts ------------------------------

/** Optional free text, ≤500 chars (a custom line's description — shorter
 * than the 2000-char catalog description since this is a one-off freeform
 * note, not a product blurb). Missing/empty collapses to `undefined`. */
const customLineDescriptionSchema = z.preprocess(
  (value) =>
    value === null || value === undefined || (typeof value === "string" && value.trim() === "")
      ? undefined
      : value,
  z.string().max(500, "Description must be at most 500 characters").optional()
);

/** Integer quantity, 1..999 — shared by custom lines and option selections. */
const qtySchema = z.coerce
  .number({ error: "Qty must be a number" })
  .int("Qty must be a whole number")
  .min(1, "Qty must be at least 1")
  .max(999, "Qty must be at most 999");

/** A custom line may be negative: a trade-in is entered as a line with a minus,
 * which keeps one mechanism serving many purposes (see the P0 spec, Part C).
 * Option and product lines keep the non-negative rule — a negative option is a
 * data error, not a discount. */
const SIGNED_AMOUNT_REGEX = /^-?\d+(\.\d{1,2})?$/;

/** Optional `/api/files/<name>` URL for a custom line's own photo (see
 * `DocumentLine.imageUrl` — a trade-in or bought-in item can carry a photo
 * the same way a product line does). Missing/blank collapses to `undefined`,
 * same preprocessing pattern as `customLineDescriptionSchema`. Validated
 * against the shared `IMAGE_URL_PATTERN` so a client can never smuggle an
 * arbitrary URL onto a document line — only a URL this app's own upload
 * route could have produced. */
const customLineImageUrlSchema = z.preprocess(
  (value) =>
    value === null || value === undefined || (typeof value === "string" && value.trim() === "")
      ? undefined
      : value,
  z.string().regex(IMAGE_URL_PATTERN, "Invalid image URL").optional()
);

/** A freeform document-level line (e.g. "Delivery", "Install") added via the
 * builder's "Extra lines" section. `unitPrice` is kept as a validated string
 * (not coerced to a number) so it can be handed straight to
 * `new Prisma.Decimal(...)` without float rounding — same pattern as
 * `priceInputSchema` in validation/catalog.ts. */
export const customLineSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(200, "Name must be at most 200 characters"),
  qty: qtySchema,
  unitPrice: z
    .string()
    .trim()
    .regex(SIGNED_AMOUNT_REGEX, "Unit price must be a number with at most 2 decimal places"),
  description: customLineDescriptionSchema,
  imageUrl: customLineImageUrlSchema,
});
export type CustomLineInput = z.infer<typeof customLineSchema>;

/**
 * A discount's mode (item- or document-level): "PERCENT" (a share of the
 * base) or "AMOUNT" (a fixed cash figure in the document's currency) — see
 * the `DiscountMode` enum in schema.prisma. No `null`/empty collapsing here
 * (unlike `discountValueSchema`): the mode always has a value, defaulting to
 * "PERCENT" server-side when a caller omits it (matches the column default).
 */
export const discountModeSchema = z.enum(["PERCENT", "AMOUNT"]);
export type DiscountModeInput = z.infer<typeof discountModeSchema>;

const DISCOUNT_VALUE_REGEX = /^\d{1,9}(\.\d{1,2})?$/;

/**
 * A discount's value (item- or document-level): an empty string (or a
 * missing/`null` FormData value) means "clear the discount" and collapses to
 * `null`; otherwise it must be a non-negative decimal with at most 2 decimal
 * places, kept as a string (not `Number`-transformed) so it can go straight
 * to `new Prisma.Decimal(...)` without a float round-trip — same pattern as
 * `customLineSchema.unitPrice`. Deliberately permissive on range: up to 9
 * digits before the point covers a plausible AMOUNT figure, and the engine
 * (`discountCents` in src/lib/pricing.ts) clamps an AMOUNT to its base
 * regardless of what's typed here.
 *
 * This schema alone cannot enforce "a PERCENT value must be 0..100" — it has
 * no way to know which mode a given value is paired with (that's a property
 * of the *pair*, not the value in isolation). That check lives in
 * `exceedsPercentCeiling` below instead, called once mode and value are both
 * known — see its own doc comment for why that's the one place it can't be
 * bypassed.
 */
export const discountValueSchema = z.preprocess(
  (value) =>
    value === null || value === undefined || (typeof value === "string" && value.trim() === "")
      ? null
      : value,
  z.union([
    z.null(),
    z
      .string()
      .trim()
      .regex(DISCOUNT_VALUE_REGEX, "Enter a number with at most 2 decimal places"),
  ])
);
export type DiscountValueInput = z.infer<typeof discountValueSchema>;

/**
 * `true` when `mode`/`value` together describe an out-of-range PERCENT
 * discount (over 100%) — `discountValueSchema` validates `value`'s shape in
 * isolation and has no way to apply this rule itself (see its doc comment).
 * Every write path that accepts a discount (`setItemDiscount`/
 * `setDocumentDiscount` in src/lib/actions/documents.ts) parses `mode` and
 * `value` and then calls this exactly once before persisting, so there is
 * one single place the 100% ceiling is enforced — not duplicated per call
 * site, where a future third call site could forget it. An AMOUNT value (or
 * a cleared/`null` value) is never subject to this check: the engine clamps
 * an AMOUNT to its base instead (see `discountCents`).
 */
export function exceedsPercentCeiling(mode: DiscountModeInput, value: DiscountValueInput): boolean {
  return mode === "PERCENT" && value !== null && Number(value) > 100;
}

// --- delivery terms (Ex Works carries no GST) -------------------------------

/** `setDeliveryTerms`'s input — DELIVERED (the domestic default) or
 * EX_WORKS (an export sale collected at the factory door, not a domestic
 * taxable supply — see the `DeliveryTerms` enum in schema.prisma). No
 * `null`/empty collapsing (unlike `discountValueSchema`): there is no "clear
 * it" state, only a choice between the two terms, mirroring
 * `discountModeSchema`'s shape one field over. */
export const deliveryTermsSchema = z.enum(["DELIVERED", "EX_WORKS"]);
export type DeliveryTermsInput = z.infer<typeof deliveryTermsSchema>;

/** A non-negative decimal with at most 2 decimal places, up to 9 digits
 * before the point (same bound as `DISCOUNT_VALUE_REGEX`) — a hand-typed
 * unit price (`setItemUnitPrice`/`setLineUnitPrice` in
 * src/lib/actions/documents.ts). Kept as a validated string, not
 * `Number`-coerced, so it goes straight to `new Prisma.Decimal(...)` without
 * a float round-trip — same pattern as `customLineSchema.unitPrice` and
 * `discountValueSchema`. Deliberately allows `0` (John: "if I give it away
 * for zero dollars... I give them back zero dollars") but not a negative
 * value — unlike a custom extra line (which enters a trade-in as a negative
 * unitPrice, see `SIGNED_AMOUNT_REGEX`), a catalogue item/option's price
 * being hand-set is a discount at most, never a rebate. */
const UNIT_PRICE_REGEX = /^\d{1,9}(\.\d{1,2})?$/;
export const unitPriceSchema = z
  .string()
  .trim()
  .regex(UNIT_PRICE_REGEX, "Enter a non-negative number with at most 2 decimal places");
export type UnitPriceInput = z.infer<typeof unitPriceSchema>;

/** `unitPriceSchema`'s one exception: a credit item's (`Product.isCredit` —
 * the TRADE-IN product) own hand-set price (`setItemUnitPrice`, gated on
 * `item.product?.isCredit` there). A salesperson entering a trade-in reads
 * the row as already negative on screen, so typing `-20000` for it is a
 * reasonable mental model, not a mistake worth interrupting them over — this
 * schema allows one optional leading `-` on top of `UNIT_PRICE_REGEX`, and
 * `setItemUnitPrice` strips it (taking the absolute value) before storing:
 * the sign a credit item's amount prints with comes from `EngineItem.isCredit`
 * alone, same as everywhere else in this app (see that field's doc comment in
 * src/lib/pricing.ts for why the sign is deliberately kept out of the typed
 * value), never from what was typed here. An ORDINARY item/option still goes
 * through plain `unitPriceSchema` and rejects a negative outright — there, a
 * minus really is a data-entry mistake (a negative price on a machine or an
 * option is nonsensical), not an alternate way to type the same thing. */
const CREDIT_UNIT_PRICE_REGEX = /^-?\d{1,9}(\.\d{1,2})?$/;
export const creditUnitPriceSchema = z
  .string()
  .trim()
  .regex(CREDIT_UNIT_PRICE_REGEX, "Enter a number with at most 2 decimal places")
  .transform((value) => (value.startsWith("-") ? value.slice(1) : value));
export type CreditUnitPriceInput = z.infer<typeof creditUnitPriceSchema>;

/** One option selection from the item options editor: the option's code,
 * the quantity of it on the item, and (when the option carries an
 * `attributeSchema`) the freeform attribute values keyed by attribute
 * `key`. Value type is loosely `string | number` — the editor renders
 * "number" and "text" attribute inputs and this schema doesn't re-validate
 * per-attribute types against the option's schema (that's a display/UX
 * concern, not a data-integrity one: the value is stored as-is in
 * `DocumentLine.attributes` Json). */
export const optionSelectionSchema = z.object({
  optionCode: z.string().trim().min(1, "Option code is required").max(120, "Option code is too long"),
  qty: qtySchema,
  attributes: z.record(z.string(), z.union([z.string(), z.number()])).optional(),
});
export type OptionSelectionInput = z.infer<typeof optionSelectionSchema>;

// --- credit item fields (trade-in: which machine is being taken) -----------

/** `DocumentItem.serialNumber` — for a credit item (`Product.isCredit`, the
 * TRADE-IN catalogue product) this is where the salesperson records the
 * serial number of the specific machine being taken in trade (see the
 * "Recording the machine taken" design note: `DocumentItem` already has this
 * column, so no new one was added — it's simply made editable, for a credit
 * item, via `setItemSerialNumber`). Missing/blank collapses to `null`
 * (clears it) rather than `undefined`, matching `notesSchema`'s pattern for
 * the same reason: this feeds a Prisma write directly and the column is
 * nullable, not omittable. 200 chars is generous for any real serial number
 * format while still rejecting an obviously-wrong paragraph-length paste. */
export const serialNumberSchema = z.preprocess(
  (value) =>
    value === null || value === undefined || (typeof value === "string" && value.trim() === "")
      ? null
      : value,
  z.union([z.null(), z.string().trim().max(200, "Serial number must be at most 200 characters")])
);
export type SerialNumberInput = z.infer<typeof serialNumberSchema>;

// --- item reordering (drag-and-drop) ---------------------------------------

/** The full ordered list of a document's item ids submitted by the builder's
 * drag-and-drop / up-down reorder UI. Bounded to 100 (matches
 * `MAX_OPTION_SELECTIONS` — no document is expected to ever carry more items
 * than that) and rejects duplicates outright; the *set* of ids still has to
 * be checked against the document's actual items by the caller (see
 * `isPermutation`) since a schema alone can't know what the document holds. */
export const reorderSchema = z
  .array(idSchema, { error: "Invalid order" })
  .min(1, "Invalid order")
  .max(100, "Invalid order")
  .refine((ids) => new Set(ids).size === ids.length, "Duplicate item in order");
export type ReorderInput = z.infer<typeof reorderSchema>;

// --- price display toggles (quotation-first) --------------------------------

/** `setPriceDisplay`'s input: both flags are plain booleans (the builder UI
 * toggles them straight from a checkbox's `checked` state, no FormData
 * string-coercion involved — same calling convention as
 * `setItemShowImage`). */
export const priceDisplaySchema = z.object({
  showItemPrices: z.boolean(),
  showOptionPrices: z.boolean(),
});
export type PriceDisplayInput = z.infer<typeof priceDisplaySchema>;

// --- notes (free-text, markdown) --------------------------------------------

/** `setDocumentNotes`'s input: `Document.notes` — free-text markdown edited
 * from the builder's Notes section (see `NotesSection`,
 * src/components/builder/notes-section.tsx). Missing/blank collapses to
 * `null` (clears the field) rather than `undefined`, since — unlike
 * `userNameSchema`'s optional-field pattern — this schema feeds a Prisma
 * write directly and `Document.notes` is nullable, not omittable. 5000 chars
 * — a generous freeform-remarks ceiling, well above the 500-char
 * `customLineDescriptionSchema` bound but still short of the 20000-char
 * content-block body limit (this is quote-specific remarks, not a reusable
 * template). */
export const notesSchema = z.preprocess(
  (value) =>
    value === null || value === undefined || (typeof value === "string" && value.trim() === "")
      ? null
      : value,
  z.union([z.null(), z.string().trim().max(5000, "Notes must be at most 5000 characters")])
);
export type NotesInput = z.infer<typeof notesSchema>;

// --- validity (per-quote override) ------------------------------------------

/** Days a quote stays valid, or null for "use the org-wide setting" — the
 * nullable form of the shared rule in ./validity-days, which the settings
 * page's mandatory `quoteValidityDaysSchema` builds on too. */
export const validityDaysSchema = z.preprocess(
  (v) => (v === null || v === undefined || (typeof v === "string" && v.trim() === "") ? null : v),
  z.union([z.null(), validityDayCountSchema()])
);
export type ValidityDaysInput = z.infer<typeof validityDaysSchema>;

/**
 * Pure set-equality check used to validate a proposed reorder: `proposed`
 * must contain exactly the same ids as `actual` — same set, no duplicates,
 * no missing or extra members — regardless of order (order is the whole
 * point of the caller's request, so it's deliberately not compared here).
 * Two empty arrays count as a permutation of each other. Duplicates in
 * either array make it fail (checked via length-after-Set-dedupe rather than
 * relying on `reorderSchema` having already caught it, so this helper is
 * safe to call standalone in a unit test).
 */
export function isPermutation(proposed: string[], actual: string[]): boolean {
  if (proposed.length !== actual.length) return false;
  const proposedSet = new Set(proposed);
  const actualSet = new Set(actual);
  if (proposedSet.size !== proposed.length) return false;
  if (actualSet.size !== actual.length) return false;
  if (proposedSet.size !== actualSet.size) return false;
  for (const id of proposedSet) {
    if (!actualSet.has(id)) return false;
  }
  return true;
}
