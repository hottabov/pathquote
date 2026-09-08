"use client";

import { useRef, useState, useTransition, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { FieldRow, fieldInputClass } from "@/components/ui-kit";
import { useToast } from "@/components/ui-kit/client";
import { RichTextEditor, type RichTextEditorHandle } from "@/components/ui-kit/rich-text-editor-lazy";
import { toEditorHtml } from "@/lib/rich-text-core";
import type { QuoteToken } from "@/lib/quote-variables";
import type { ActionResult } from "@/lib/actions/quote-documents";
import { DocumentPreview } from "./document-preview";

/**
 * The ADMIN's editor for one version of one quote document — the default, or
 * a single region's own copy. Title, the whole document in one rich-text
 * field, the "include on new quotes" flag, a palette of the eight document
 * tokens, and a preview.
 *
 * `useTransition` + a manual `onSubmit` rather than `useActionState`, for the
 * reason the content-block form it succeeds gave: this save never navigates away — the admin stays on the same region
 * tab — so success needs a signal of its own, which a `useActionState` result
 * cannot give without an extra effect watching it change.
 *
 * A failure shows inline only, via the `<p role="alert">` below, and
 * deliberately does NOT also fire `toast.error`. The equivalent catalog card
 * did both until a review pointed out that it announced the same sentence
 * twice to a screen reader and then took the more useful copy away after a
 * few seconds — and the failure here is usually "no value exists for
 * {{someToken}}", which is a thing to read while hunting through the body,
 * not a flash. Success keeps its toast, because there is nothing on screen
 * for it to be.
 *
 * `defaultValues.body` may still be a legacy markdown row, so `toEditorHtml`
 * normalizes it once for the editor's initial mount; from then on `body`
 * state is HTML, submitted through a hidden `name="body"` input because the
 * editor has no native form control for `FormData` to read.
 * `updateQuoteDocument` sanitizes on write, so this component doesn't.
 */
export function QuoteDocumentForm({
  action,
  idPrefix,
  bodyLabel,
  defaultValues,
  tokens,
  createFields,
  submitLabel = "Save changes",
  pendingLabel = "Saving…",
  successMessage = "Saved",
  onSuccess,
}: {
  action: (formData: FormData) => Promise<ActionResult>;
  idPrefix: string;
  /** Names what is being edited — "Default document", "US version" — so the
   * region tab a reader is on is legible from the field itself and not only
   * from the tab strip above it. */
  bodyLabel: string;
  defaultValues: { title: string; body: string; includedByDefault: boolean };
  tokens: QuoteToken[];
  /** Present only when this form is CREATING a document rather than editing
   * one. It adds the key field — the one field that exists exactly once in a
   * document's life — and the sort position the new document takes, which
   * `reorderQuoteDocuments` rewrites from then on and no edit form ever
   * resubmits. Everything else about the two modes is deliberately identical:
   * the same editor, the same palette, the same emptiness rule, so an author
   * writing their first Data Processing Agreement meets the screen they
   * already know from editing Terms. */
  createFields?: { sortOrder: number };
  submitLabel?: string;
  pendingLabel?: string;
  successMessage?: string;
  /** Runs after a successful submit, before the toast — how the create page
   * navigates to the document it just made. */
  onSuccess?: () => void;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [body, setBody] = useState(() => toEditorHtml(defaultValues.body));
  const [key, setKey] = useState("");
  const editorRef = useRef<RichTextEditorHandle>(null);
  const toast = useToast();
  const bodyLabelId = `${idPrefix}-body-label`;
  const keyHintId = `${idPrefix}-key-hint`;
  // What the server will actually store: `newQuoteDocumentSchema` trims and
  // lowercases. Echoed back below the field so an admin typing "DPA" sees the
  // key they are permanently choosing, rather than discovering it in the URL
  // afterwards.
  const normalizedKey = key.trim().toLowerCase();

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    setError(null);
    startTransition(async () => {
      const result = await action(formData);
      if (result?.error) {
        setError(result.error);
        return;
      }
      onSuccess?.();
      toast.success(successMessage);
    });
  }

  return (
    // Palette first in the DOM, editor second — then `lg:col-start-*` /
    // `lg:row-start-1` put them side by side, editor left, at `lg`. This is
    // the arrangement `SeriesQuoteDescriptionCard` landed on after review,
    // and it is copied here on purpose: an author must not meet two different
    // variable palettes in one product. Reversing the source order rather
    // than pinning the palette with an `order-*` utility is what makes the
    // narrow layout honest — below `lg` the single column reads, tabs and
    // paints palette-then-editor, so the reference is above the field and the
    // Save button instead of scrolled off below both.
    <form onSubmit={handleSubmit} className="grid grid-cols-1 gap-6 lg:grid-cols-3 lg:items-start">
      <div className="rounded-xl border border-slate-200 bg-white p-4 lg:col-start-3 lg:row-start-1">
        <h3 className="text-sm font-semibold text-brand-dark">Insert a variable</h3>
        <p className="mt-1 text-xs text-slate-500">
          Every quote fills these in from its own figures. A variable a quote has no value for takes its
          whole line with it rather than printing a blank.
        </p>
        {tokens.length === 0 ? (
          <p className="mt-2 text-sm text-slate-500">No variables available.</p>
        ) : (
          // Two lines per token, monospace name above its full source text,
          // never a tooltip and never clipped: the palette IS the
          // documentation for what each token means, so a reader must be able
          // to learn what {{validityDate}} does without hovering. `min-w-0` +
          // `break-words` keep a long source sentence wrapping inside its
          // column instead of widening the card. Two columns from `sm` to
          // `lg` — the widths where the palette is full-bleed above the
          // editor — halve how far the editor is pushed down; at `lg` it is a
          // narrow sidebar again, so it goes back to one.
          <ul className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-1">
            {tokens.map((quoteToken) => (
              <li key={quoteToken.token} className="min-w-0">
                <button
                  type="button"
                  disabled={pending}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => editorRef.current?.insertContent(`{{${quoteToken.token}}}`)}
                  className="focus-ring flex h-full w-full min-w-0 flex-col items-start gap-0.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-left transition-colors hover:border-brand/30 hover:bg-brand/5 disabled:pointer-events-none disabled:opacity-50"
                >
                  <span className="font-mono text-xs text-brand-dark">{`{{${quoteToken.token}}}`}</span>
                  <span className="break-words text-xs text-slate-500">{quoteToken.source}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="flex flex-col gap-4 lg:col-span-2 lg:col-start-1 lg:row-start-1">
        {createFields ? (
          <div className="flex flex-col gap-1.5">
            <FieldRow label="Key" htmlFor={`${idPrefix}-key`}>
              <input
                id={`${idPrefix}-key`}
                name="key"
                value={key}
                onChange={(event) => setKey(event.target.value)}
                maxLength={60}
                required
                autoCapitalize="off"
                autoCorrect="off"
                spellCheck={false}
                disabled={pending}
                aria-describedby={keyHintId}
                placeholder="dpa"
                className={fieldInputClass}
              />
            </FieldRow>
            {/* Visible helper text under the field, not a placeholder and not
                a tooltip: this states a rule the admin cannot undo, and a
                placeholder disappears the moment they start typing. */}
            <p id={keyHintId} className="text-xs text-slate-500">
              Letters, numbers, dots and hyphens.{" "}
              <span className="font-medium text-slate-700">
                A document&rsquo;s key can never be changed.
              </span>{" "}
              It is how a quote records that this document was left out, and how the migration and
              every link to it refer to it.
            </p>
            {normalizedKey ? (
              <p className="text-xs text-slate-500">
                Saved as <span className="font-mono text-brand-dark">{normalizedKey}</span>, at{" "}
                <span className="font-mono text-brand-dark">/documents/{normalizedKey}</span>
              </p>
            ) : null}
            {/* The new document's print position — last, after everything
                that already exists. Not a field: an existing document's
                position is set by dragging the list, and offering a number
                here would give the admin two places to set one thing. */}
            <input type="hidden" name="sortOrder" value={createFields.sortOrder} />
          </div>
        ) : null}

        <FieldRow label="Printed heading" htmlFor={`${idPrefix}-title`}>
          <input
            id={`${idPrefix}-title`}
            name="title"
            defaultValue={defaultValues.title}
            maxLength={200}
            required
            disabled={pending}
            className={fieldInputClass}
          />
        </FieldRow>

        <div className="flex flex-col gap-1.5">
          {/* Not a `<label htmlFor>` — the target is Tiptap's contentEditable
              surface plus a row of toolbar buttons, not one labelable form
              control, so a `for` would dangle. Associated with
              `aria-labelledby` on a wrapping group instead, the same way
              `SeriesQuoteDescriptionCard` does it. */}
          <span id={bodyLabelId} className="text-sm font-medium text-brand-dark">
            {bodyLabel}
            <span className="ml-0.5 text-destructive" aria-hidden="true">
              *
            </span>
          </span>
          {/* The editor has no native form control `FormData` can read — this
              hidden input is what actually submits `body`. */}
          <input type="hidden" name="body" value={body} />
          <div role="group" aria-labelledby={bodyLabelId}>
            <RichTextEditor ref={editorRef} value={body} onChange={setBody} disabled={pending} />
          </div>
        </div>

        <label className="flex items-start gap-2 text-sm text-slate-700">
          <input
            type="checkbox"
            name="includedByDefault"
            defaultChecked={defaultValues.includedByDefault}
            disabled={pending}
            className="mt-0.5 size-4 shrink-0 rounded border-slate-300 accent-brand"
          />
          <span>
            Include on new quotes
            <span className="block text-xs text-slate-500">
              An author can still untick it on an individual quote.
            </span>
          </span>
        </label>

        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}

        <Button
          type="submit"
          disabled={pending}
          className="h-11 w-full bg-brand text-white hover:bg-brand/90 sm:w-auto sm:self-start"
        >
          {pending ? pendingLabel : submitLabel}
        </Button>

        {/* Reads the live editor state, not `defaultValues` — the point of a
            preview here is to check the sentence just typed. */}
        <DocumentPreview idPrefix={idPrefix} getBody={() => body} />
      </div>
    </form>
  );
}
