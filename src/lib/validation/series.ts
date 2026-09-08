import { z } from "zod";

/** The entity forms of a non-breaking space — the character Tiptap writes
 * into a paragraph an author blanked out. `String.prototype.trim` already
 * removes the literal ` `, so only the encoded forms need decoding. */
const NBSP_ENTITY_PATTERN = /&nbsp;|&#160;|&#x0*a0;/gi;

/**
 * True when a body would print nothing at all: no visible text survives once
 * the tags are removed and `&nbsp;` is treated as the whitespace it renders
 * as.
 *
 * A `.trim() === ""` test is not enough, because the editor cannot produce
 * `""`. Tiptap's `getHTML()` returns `<p></p>` for an empty document, and
 * `<p><br></p>` / `<p>&nbsp;</p>` for a paragraph an author emptied by hand —
 * all of them truthy, all of them printing an empty block under the product's
 * heading instead of falling through to the auto-generated spec sentence, and
 * one of them (`<p></p>`) already sitting in the repo's real-data fixture at
 * tests/fixtures/catalog-dump.json. The card promises "Leave empty to print
 * nothing"; this is what makes that true for the inputs the editor actually
 * emits. Rich text carries no void elements that print without text (see
 * `ALLOWED_TAGS` in rich-text-core.ts — no `<img>`), so "no text" really does
 * mean "nothing to print".
 */
function hasNoVisibleText(body: string): boolean {
  return body.replace(/<[^>]*>/g, " ").replace(NBSP_ENTITY_PATTERN, " ").trim() === "";
}

/** A category's quote copy. Empty is legitimate and stores as `null` so the
 * renderer's `?? ""` and the "prints nothing" path agree. 20000 matches the
 * limit content blocks already use. */
export const seriesQuoteDescriptionSchema = z.preprocess(
  (value) => (typeof value === "string" && hasNoVisibleText(value) ? null : value),
  z.union([z.null(), z.string().max(20000, "Quote description must be at most 20000 characters")])
);
