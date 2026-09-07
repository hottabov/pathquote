"use client";

import { useState } from "react";
import { AutosaveIndicator } from "@/components/builder/autosave-indicator";
import { RichTextEditor } from "@/components/ui-kit/rich-text-editor-lazy";
import { RICH_TEXT_PROSE_CLASS } from "@/components/ui-kit/rich-text-prose";
import { cn } from "@/lib/utils";
import { toEditorHtml } from "@/lib/rich-text-core";
import { useAutosave } from "@/lib/use-autosave";
import { setDocumentNotes } from "@/lib/actions/documents";

/**
 * The builder's "Notes" section (owner: freeform remarks on a document,
 * carried through to both renderers — the quotation sheet and the plain
 * document sheet, both via `renderStoredRichText`) — a smaller sibling of
 * `QuoteDocumentForm`'s `RichTextEditor` (WYSIWYG, formatted text shows
 * immediately, no separate preview pane) but without a title field or a
 * placeholder sidebar: just the editor, autosaved via `useAutosave`
 * (no Save button — see src/lib/use-autosave.ts) which calls
 * `setDocumentNotes` directly (DRAFT-only — see that action) 800ms after
 * typing settles.
 *
 * `notes` may still be a legacy markdown row (`toEditorHtml` normalizes it
 * to HTML for the editor on first load — see src/lib/rich-text.ts); once
 * saved, it's always HTML from then on. `setDocumentNotes` sanitizes on
 * write, so this component doesn't need to.
 *
 * Read-only (a FINAL document, or the caller otherwise passing `readOnly`)
 * renders `notesHtml` — the same `renderStoredRichText(notes)` output as
 * before, only computed by the server page that renders this component (see
 * src/app/(app)/quotes/[documentId]/page.tsx) rather than here. The
 * sanitizer is still mandatory: the markup goes straight into
 * `dangerouslySetInnerHTML` and `notes` is a raw column value that may
 * predate the write-boundary allowlist, so a legacy row's stored
 * `<script>`/`onerror=` has only that pass between it and the DOM. Running it
 * server-side keeps `isomorphic-dompurify` out of the browser chunk entirely
 * (this file was its last client-side importer) and means the safety of the
 * page no longer rests on code an attacker's own markup shares a runtime
 * with. `null` when the document has no notes at all — the caller decides
 * whether an empty `SectionCard` is worth showing in that case.
 *
 * The editable branch needs no such pass. `notes` seeds a `RichTextEditor`
 * (Tiptap), which parses incoming HTML against its own node/mark schema and
 * keeps only what that schema names — nothing here is ever handed to
 * `dangerouslySetInnerHTML`, so `toEditorHtml` alone (sanitizer-free, from
 * `@/lib/rich-text-core`) is what it has always needed and still is.
 */
export function NotesSection({
  documentId,
  notes,
  notesHtml,
  readOnly = false,
}: {
  documentId: string;
  /** The raw stored column — HTML or legacy markdown — used only to seed the
   * editor. Never rendered as markup. */
  notes: string | null;
  /** `renderStoredRichText(notes)`, sanitized server-side; `null` when there
   * are no notes. The only value this component ever renders as HTML. */
  notesHtml: string | null;
  readOnly?: boolean;
}) {
  const [body, setBody] = useState(() => toEditorHtml(notes ?? ""));
  const { status, error } = useAutosave({
    value: body,
    enabled: !readOnly,
    onSave: async (html) => {
      const formData = new FormData();
      formData.set("notes", html);
      return setDocumentNotes(documentId, formData);
    },
  });

  if (readOnly) {
    if (!notesHtml) return <p className="text-sm text-slate-500">No notes.</p>;
    return (
      <div className={cn("text-sm text-slate-700", RICH_TEXT_PROSE_CLASS)}>
        <div dangerouslySetInnerHTML={{ __html: notesHtml }} />
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm font-medium text-brand-dark">Body</span>
        <AutosaveIndicator status={status} error={error} />
      </div>
      <RichTextEditor
        value={body}
        onChange={setBody}
        placeholder="Freeform remarks for this document…"
      />
    </div>
  );
}
