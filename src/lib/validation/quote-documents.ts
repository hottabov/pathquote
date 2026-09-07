// Pure zod validation for the quote-documents admin editor (/documents),
// which replaces /settings/content. Same purity discipline as
// validation/content.ts: no `@/lib/db` or `next/*` imports, so a plain unit
// test needs no DATABASE_URL.
import { z } from "zod";

/** A quote-document key, e.g. "terms", "conditions", "rsp", or a future
 * region-only one like "dpa". Same shape `CONTENT_KEY_REGEX` used
 * (letters/digits/dots/hyphens, 2-60 chars) — nothing about a whole
 * document's key needs to be narrower than a content-block key was. */
export const QUOTE_DOCUMENT_KEY_REGEX = /^[a-z0-9.-]{2,60}$/i;

const keySchema = z.string().regex(QUOTE_DOCUMENT_KEY_REGEX, {
  message: "Key must be 2-60 characters: letters, numbers, dots, and hyphens only",
});

/** Required, unlike `ContentBlock.title` — `QuoteDocument.title` is `String`
 * (NOT NULL): it IS the printed heading, not an optional label a rendered
 * fragment could do without. */
const titleSchema = z
  .string()
  .trim()
  .min(1, "Title is required")
  .max(200, "Title must be at most 200 characters");

/** The entity forms of a non-breaking space — the character Tiptap writes
 * into a paragraph an author blanked out. Duplicated from
 * validation/series.ts's own pattern (that module exports only its schema,
 * not the helper) rather than imported — same "small and duplicated beats a
 * cross-module import" rule `reorderProductsSchema` follows below. */
const NBSP_ENTITY_PATTERN = /&nbsp;|&#160;|&#x0*a0;/gi;

/**
 * True when a body would print nothing at all: no visible text survives once
 * the tags are removed and `&nbsp;` is treated as the whitespace it renders
 * as. Same test `seriesQuoteDescriptionSchema` (validation/series.ts) uses —
 * but the opposite verdict follows from it here. A category's copy may
 * legitimately be empty (it maps to `null` there); a legal document must
 * NOT be, because unlike a missing category sentence a blank Terms page
 * would print, unremarked, on a customer's quote. Tiptap's `getHTML()`
 * returns `<p></p>` for an untouched empty document, and `<p><br></p>` /
 * `<p>&nbsp;</p>` for a paragraph emptied by hand — all of them truthy, none
 * of them worth saving.
 */
function hasNoVisibleText(body: string): boolean {
  return body.replace(/<[^>]*>/g, " ").replace(NBSP_ENTITY_PATTERN, " ").trim() === "";
}

/** HTML (or legacy markdown) body, 1-20000 chars, and — unlike a category's
 * copy — never blank in substance: `hasNoVisibleText` catches every shape
 * Tiptap's editor can produce for "nothing written" (see its own doc
 * comment), on top of the plain `min(1)` that catches a literal `""`. */
const bodySchema = z
  .string()
  .min(1, "Body is required")
  .max(20000, "Body must be at most 20000 characters")
  .refine((value) => !hasNoVisibleText(value), { message: "Body is required" });

/** Non-negative integer sort order; missing/empty defaults to 0. Used only by
 * `createQuoteDocument` — an existing document's position is set by
 * `reorderQuoteDocuments`, never resubmitted alongside its own edit. */
const sortOrderSchema = z.preprocess(
  (value) => (value === "" || value === null || value === undefined ? 0 : value),
  z.coerce
    .number({ error: "Sort order must be a number" })
    .int("Sort order must be a whole number")
    .min(0, "Sort order must be 0 or greater")
);

/** A checkbox's raw FormData value ("on" when checked, absent/null when
 * unchecked) coerced to a real boolean. Duplicated from
 * validation/catalog.ts's own (unexported) `checkboxBooleanSchema` rather
 * than imported — the two rules happen to be identically shaped, not
 * actually dependent on each other, the same relationship
 * `reorderProductsSchema` has to `reorderProducts`' id-list check. */
const checkboxBooleanSchema = z.preprocess(
  (value) => value === "on" || value === true || value === "true" || value === "1",
  z.boolean()
);

/** Title, body and the "included by default" flag — every field
 * `updateQuoteDocument` accepts. `key` and `regionCode` reach that action as
 * separate arguments, not through this schema (route params / explicit
 * arguments, not form fields — same split `contentBlockSchema` made). */
export const quoteDocumentSchema = z.object({
  title: titleSchema,
  body: bodySchema,
  includedByDefault: checkboxBooleanSchema,
});

export type QuoteDocumentInput = z.infer<typeof quoteDocumentSchema>;

/** `quoteDocumentSchema` plus the two fields only `createQuoteDocument`
 * needs: the new document's own key, and its starting sort position. */
export const newQuoteDocumentSchema = quoteDocumentSchema.extend({
  key: keySchema,
  sortOrder: sortOrderSchema,
});

export type NewQuoteDocumentInput = z.infer<typeof newQuoteDocumentSchema>;

/** Re-exported (not redeclared) so `createRegionVersion`/`deleteRegionVersion`
 * in src/lib/actions/quote-documents.ts can import region-code validation
 * from here while there is only one region-code rule in the codebase — same
 * re-export validation/content.ts made. */
export { regionCodeSchema } from "./region-code";

/** A reordered list of every document key — duplicated from
 * `reorderProductsSchema` in validation/catalog.ts for the same reason that
 * one duplicates `isPermutation` from validation/documents.ts: an
 * identically-shaped id-list schema that happens not to actually depend on
 * the other module. Plain strings, not validated by `QUOTE_DOCUMENT_KEY_REGEX`
 * shape here — the *set* still has to be checked against what the database
 * actually holds, which is `isQuoteDocumentKeyPermutation`'s job. */
export const reorderQuoteDocumentsSchema = z
  .array(z.string().min(1), { error: "Invalid order" })
  .min(1, "Invalid order")
  .max(100, "Invalid order")
  .refine((keys) => new Set(keys).size === keys.length, "Duplicate document in order");

export type ReorderQuoteDocumentsInput = z.infer<typeof reorderQuoteDocumentsSchema>;

/** Pure set-equality check — duplicated from `isProductPermutation` in
 * validation/catalog.ts, itself a duplicate of `isPermutation`. `proposed`
 * must contain exactly the same keys as `actual`, any order. */
export function isQuoteDocumentKeyPermutation(proposed: string[], actual: string[]): boolean {
  if (proposed.length !== actual.length) return false;
  const proposedSet = new Set(proposed);
  const actualSet = new Set(actual);
  if (proposedSet.size !== proposed.length) return false;
  if (actualSet.size !== actual.length) return false;
  for (const key of proposedSet) {
    if (!actualSet.has(key)) return false;
  }
  return true;
}
