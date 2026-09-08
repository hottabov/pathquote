/**
 * Prose styling for rendered rich-text content — both the live editing
 * surface in `RichTextEditor` and, via `renderStoredRichText`, every
 * read-only consumer (quotation sheet block bodies/notes, the builder's
 * read-only Notes view). Same hand-rolled ruleset the old markdown preview
 * panes used (previously duplicated in notes-section.tsx and the content-block
 * form that preceded quote-document-form.tsx), extended with `ol`/`a`/`blockquote` now that the
 * editor can produce them. There's no @tailwindcss/typography plugin in this
 * project, hence the arbitrary-variant approach rather than a `prose` class.
 *
 * Lives in its own module, apart from the editor it styles, because the
 * read-only consumers want the class string without wanting Tiptap: the
 * editor is loaded lazily (see rich-text-editor-lazy.tsx) and a static import
 * of this constant from rich-text-editor.tsx would pull the whole editor —
 * and ~200KB of ProseMirror behind it — straight back into the importer's
 * chunk, defeating the split.
 */
export const RICH_TEXT_PROSE_CLASS =
  "[&_h1]:mt-3 [&_h1]:mb-1.5 [&_h1]:text-lg [&_h1]:font-semibold [&_h1]:text-brand-dark [&_h1:first-child]:mt-0 " +
  "[&_h2]:mt-3 [&_h2]:mb-1.5 [&_h2]:text-base [&_h2]:font-semibold [&_h2]:text-brand-dark [&_h2:first-child]:mt-0 " +
  "[&_h3]:mt-3 [&_h3]:mb-1.5 [&_h3]:text-sm [&_h3]:font-semibold [&_h3]:text-brand-dark [&_h3:first-child]:mt-0 " +
  "[&_p]:mb-2 [&_p:last-child]:mb-0 " +
  "[&_ul]:mb-2 [&_ul]:list-disc [&_ul]:pl-5 [&_ul:last-child]:mb-0 [&_ul_ul]:mt-1 [&_ul_ul]:mb-0 " +
  "[&_ol]:mb-2 [&_ol]:list-decimal [&_ol]:pl-5 [&_ol:last-child]:mb-0 " +
  "[&_li]:mb-0.5 [&_strong]:font-semibold [&_strong]:text-brand-dark [&_em]:italic " +
  "[&_a]:text-brand [&_a]:underline [&_a]:underline-offset-2 " +
  "[&_blockquote]:border-l-2 [&_blockquote]:border-slate-200 [&_blockquote]:pl-3 [&_blockquote]:text-slate-500 [&_blockquote]:italic";
