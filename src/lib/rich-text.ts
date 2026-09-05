// Pure helpers for the WYSIWYG rich-text editor (RichTextEditor, Tiptap) and
// its HTML-content-storage story. `ContentBlock.body` and `Document.notes`
// used to be markdown, hand-typed into a textarea (see src/lib/markdown.ts /
// src/lib/markdown-editor.ts, still kept around — see their own doc
// comments). Rows written by the WYSIWYG editor store Tiptap's HTML output
// instead, so every reader of stored content now has to handle BOTH shapes:
// old rows are still markdown, new rows (and any row an admin re-saves) are
// HTML. This module is that seam: `isHtmlContent` tells the two shapes
// apart, `toEditorHtml` normalizes either shape to HTML for loading INTO the
// editor, `sanitizeRichText` allowlist-sanitizes untrusted-ish editor HTML
// before it's ever stored or rendered, and `renderStoredRichText` is the one
// function every sheet/renderer should call on a stored body/notes value
// instead of `renderMarkdown` directly.
//
// No `@/lib/db` or `next/*` imports — same discipline as markdown.ts — so a
// plain `vitest run` of this file never needs `DATABASE_URL` set.
//
// `isHtmlContent`/`toEditorHtml` physically live in ./rich-text-core and are
// re-exported below: they need no sanitizer, and the client components that
// seed an editor from a stored value import them from there so that
// `isomorphic-dompurify` never reaches a browser chunk. This module stays the
// complete public surface — every server-side caller, and every test, can go
// on importing all six functions from "@/lib/rich-text".
import DOMPurify from "isomorphic-dompurify";
import { renderMarkdown } from "./markdown";
import { ALLOWED_TAGS, isHtmlContent, toEditorHtml } from "./rich-text-core";

export { isHtmlContent, toEditorHtml };

/** Only `href` survives sanitization — no `style`, no `on*` handlers, no
 * `target`/`class`/anything else an editor or a hand-crafted HTML payload
 * might carry. */
const ALLOWED_ATTR = ["href"];

/** Restricts `href` to `http:`/`https:`/`mailto:` — DOMPurify's own default
 * `ALLOWED_URI_REGEXP` is far more permissive (it also allows relative URLs,
 * `tel:`, `cid:`, etc.), which is more latitude than a quotation's rich-text
 * link ever needs. Anything else (`javascript:`, `data:`, a bare relative
 * path, an unrecognised scheme) gets its `href` attribute dropped entirely —
 * DOMPurify still keeps the `<a>` tag and its text content, just without a
 * live link. */
const SAFE_HREF_PATTERN = /^(?:https?:|mailto:)/i;

/**
 * Allowlist-sanitizes editor-produced (or otherwise untrusted-ish) HTML down
 * to exactly the tags/attributes this app's sheets know how to style:
 * `ALLOWED_TAGS`/`ALLOWED_ATTR` above, `href` further restricted to
 * `SAFE_HREF_PATTERN`. Everything else — `<script>`, `<iframe>`, `style=`,
 * `on*=` handlers, a `javascript:`/`data:` href, any tag/attribute not on
 * the allowlist — is stripped; DOMPurify keeps the *text content* of a
 * stripped tag (so a rejected wrapper never silently deletes the admin's
 * words), except for tags it always drops entirely regardless of allowlist
 * (`<script>`/`<style>` and the like never leak their contents as text).
 *
 * Called from two places: server actions writing `ContentBlock.body` /
 * `Document.notes` (defense at the write boundary — see setDocumentNotes/
 * updateContentBlock/createRegionOverride), and `renderStoredRichText` below
 * (defense at the read boundary too, so a row written before this
 * allowlist existed, or written by any future direct-DB path, still renders
 * safely).
 */
export function sanitizeRichText(html: string): string {
  return DOMPurify.sanitize(html, {
    ALLOWED_TAGS,
    ALLOWED_ATTR,
    ALLOWED_URI_REGEXP: SAFE_HREF_PATTERN,
  });
}

/**
 * The one function every sheet/renderer (quotation-data.ts, quotation-sheet)
 * should call on a stored body/notes value: sanitizes already-HTML content,
 * or runs legacy markdown through `renderMarkdown` exactly as before —
 * `renderMarkdown` HTML-escapes its input up front, so that branch is safe
 * by construction the same way it always was, this function just adds the
 * HTML branch on top.
 */
export function renderStoredRichText(stored: string): string {
  return isHtmlContent(stored) ? sanitizeRichText(stored) : renderMarkdown(stored);
}

/**
 * The write-boundary counterpart to `renderStoredRichText`: sanitizes `value`
 * if it's HTML, otherwise returns it unchanged (legacy markdown/plain text
 * is stored as-is, exactly as it always was — sanitization only ever applies
 * to markup a `RichTextEditor` could actually have produced). Used by every
 * server action that persists a `RichTextEditor`-backed column
 * (`ContentBlock.body`/`Document.notes` via updateContentBlock/
 * setDocumentNotes, `Product.description` via createProduct/updateProduct)
 * so the allowlist is enforced once, the same way, everywhere a stored value
 * is untrusted-ish editor output rather than assumed clean.
 */
export function sanitizeIfHtml(value: string): string {
  return isHtmlContent(value) ? sanitizeRichText(value) : value;
}

/** A handful of named/numeric entities `renderMarkdown`/Tiptap output can
 * produce that a reader actually needs decoded back to their character —
 * deliberately not a general-purpose entity decoder (this module has no
 * reason to handle arbitrary numeric code points; nothing it renders
 * produces them). */
const PLAIN_TEXT_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  "#39": "'",
  nbsp: " ",
};

/**
 * Strips a stored `Product.description` (rich text — HTML or legacy
 * markdown, see this module's header comment) or a plain field like
 * `Option.shortDescription` down to a single-line plain-text preview — for
 * a catalogue list row, which shows a truncated one-line snippet, never the
 * full rendered markup a product/option detail page does. Renders through
 * `renderStoredRichText` first so both stored shapes are handled the same
 * way, strips every tag, decodes the handful of entities that round-trip
 * survives (`PLAIN_TEXT_ENTITIES`), then collapses all whitespace — including
 * the newlines a plain textarea value can carry — to single spaces. Actual
 * one-line ellipsis truncation is left to CSS (`truncate`) at the point of
 * render, this function only ever removes markup/whitespace, never cuts the
 * string short itself. `null`/empty collapses to `null` so a caller's
 * `description ? <Cell/> : null` check stays a clean on/off switch.
 */
export function toPlainTextPreview(stored: string | null): string | null {
  if (!stored) return null;
  const html = renderStoredRichText(stored);
  const withoutTags = html.replace(/<[^>]*>/g, " ");
  const decoded = withoutTags.replace(/&(#39|amp|lt|gt|quot|nbsp);/g, (_match, entity: string) => PLAIN_TEXT_ENTITIES[entity] ?? "");
  const text = decoded.replace(/\s+/g, " ").trim();
  return text.length > 0 ? text : null;
}
