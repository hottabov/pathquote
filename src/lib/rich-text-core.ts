// The half of the rich-text seam (see src/lib/rich-text.ts for the full
// story) that does NOT sanitize: telling a stored value's two shapes apart,
// and normalizing either shape to HTML for loading INTO the editor.
//
// Split out of rich-text.ts purely so client components can have these two
// functions without `isomorphic-dompurify`. Sanitizing is a server concern
// here — every write path runs `sanitizeIfHtml`/`sanitizeRichText` inside a
// server action, and every sheet renders through `renderStoredRichText` on
// the server — so a form that only needs to seed an editor from a stored
// value has no reason to ship a sanitizer, and `import DOMPurify` in the same
// module made that unavoidable (a side-effectful default import is not
// something a bundler will tree-shake away).
//
// Same import discipline as rich-text.ts and markdown.ts: no `@/lib/db`, no
// `next/*`.
import { renderMarkdown } from "./markdown";

/**
 * Tags `renderMarkdown` can ever produce, plus the extra inline/structural
 * tags the Tiptap editor's toolbar can produce (underline, strikethrough,
 * blockquote, links) — this is both `sanitizeRichText`'s allowlist AND (via
 * `HTML_TAG_PATTERN` below) the set `isHtmlContent` sniffs for. Deliberately
 * excludes `h1` (see `RichTextEditor`'s StarterKit config — the editor only
 * ever produces h2/h3) and anything script-like.
 */
export const ALLOWED_TAGS = ["p", "strong", "b", "em", "i", "u", "s", "h2", "h3", "ul", "ol", "li", "br", "a", "blockquote"];

/** Matches an opening or closing tag for any tag in `ALLOWED_TAGS` — used by
 * `isHtmlContent` to recognise HTML content that doesn't happen to start
 * with `<` (defensive; in practice every Tiptap-produced body does start
 * with a block tag) without misclassifying a stray literal `<`/`>` in
 * markdown prose as HTML. */
const HTML_TAG_PATTERN = new RegExp(`</?(?:${ALLOWED_TAGS.join("|")})\\b[^>]*>`, "i");

/**
 * True when `value` is HTML (Tiptap's saved output, or anything else that
 * looks like markup) rather than legacy markdown. Two checks, either
 * sufficient on its own:
 *  - the trimmed value starts with a tag (`<p>...`, `<h2>...`) — true for
 *    every row the new editor has ever saved, since Tiptap never emits a
 *    document that doesn't open with a block element;
 *  - failing that, the value contains a recognised tag anywhere (defensive
 *    fallback for content whose HTML doesn't happen to start at position 0).
 * A blank/whitespace-only value is never "HTML" (there's nothing to
 * distinguish it from empty markdown, and `toEditorHtml`/`renderStoredRichText`
 * both handle "" identically either way).
 */
export function isHtmlContent(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length === 0) return false;
  if (/^</.test(trimmed)) return true;
  return HTML_TAG_PATTERN.test(trimmed);
}

/**
 * Normalizes a stored body/notes value to HTML for loading into the
 * `RichTextEditor` — already-HTML content passes through unchanged, legacy
 * markdown is rendered once via `renderMarkdown` (the same renderer the old
 * preview pane used, so a pre-migration row opens in the new editor looking
 * exactly like its old preview did). The editor's own `onChange` then saves
 * back through `sanitizeRichText`, so once a row round-trips through the
 * editor once it's HTML from then on.
 *
 * Deliberately does NOT sanitize: what it returns goes into Tiptap's
 * `content`, which parses it into a ProseMirror document against the
 * editor's own schema — anything outside that schema is dropped there, and
 * the value is sanitized again on the way back out at the write boundary.
 */
export function toEditorHtml(stored: string): string {
  return isHtmlContent(stored) ? stored : renderMarkdown(stored);
}
