"use client";

import { useMemo, useRef, useState, useTransition, type FormEvent } from "react";
import { Button } from "@/components/ui/button";
import { FieldRow, fieldInputClass } from "@/components/ui-kit";
import { useToast } from "@/components/ui-kit/client";
import { RichTextEditor, type RichTextEditorHandle } from "@/components/ui-kit/rich-text-editor-lazy";
import { toEditorHtml } from "@/lib/rich-text-core";
import type { ActionResult } from "@/lib/actions/content";

const PLACEHOLDER_TOKEN_REGEX = /\{\{(\w+)\}\}/g;

/** Every distinct `{{token}}` name found in `body`, in first-seen order —
 * `body` is HTML now, but the regex only cares about the literal
 * `{{token}}` text, which survives unchanged whether it sits inside a `<p>`
 * or a `<li>`. */
function extractPlaceholderTokens(body: string): string[] {
  const seen = new Set<string>();
  for (const match of body.matchAll(PLACEHOLDER_TOKEN_REGEX)) {
    seen.add(match[1]);
  }
  return Array.from(seen);
}

export type ContentBlockFormValues = {
  title: string;
  body: string;
  sortOrder: number;
};

/**
 * Title/body/sortOrder form shared by the default block and every region
 * override pane. Doesn't use `useActionState` (unlike the catalog editors)
 * because this save never navigates away — the admin stays on the same
 * tab — so success needs an explicit signal; that's a plain `useTransition`
 * + toast, calling `action` directly from a manual submit handler, the same
 * pattern `CompatEditor` uses in src/components/catalog/compat-editor.tsx.
 *
 * The body field is a `RichTextEditor` (WYSIWYG — formatted text shows
 * immediately while typing, no markdown syntax visible, no separate preview
 * pane) rather than the old textarea + toolbar + preview split.
 * `defaultValues.body` may still be a legacy markdown row —
 * `toEditorHtml` normalizes it to HTML once, for the editor's initial
 * mount only; from then on `body` state is always HTML, submitted via a
 * hidden `name="body"` input since the editor itself has no native form
 * element for `FormData` to pick up. `updateContentBlock` sanitizes on
 * write, so this component doesn't need to.
 */
export function ContentBlockForm({
  action,
  idPrefix,
  defaultValues,
  placeholders,
  submitLabel = "Save changes",
}: {
  action: (formData: FormData) => Promise<ActionResult>;
  idPrefix: string;
  defaultValues: ContentBlockFormValues;
  placeholders: Record<string, string>;
  submitLabel?: string;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [body, setBody] = useState(() => toEditorHtml(defaultValues.body));
  const editorRef = useRef<RichTextEditorHandle>(null);
  const toast = useToast();

  const presentPlaceholders = extractPlaceholderTokens(body).filter((token) => token in placeholders);
  const allPlaceholderTokens = useMemo(() => Object.keys(placeholders), [placeholders]);

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formData = new FormData(event.currentTarget);
    setError(null);
    startTransition(async () => {
      const result = await action(formData);
      if (result?.error) {
        setError(result.error);
        toast.error(result.error);
        return;
      }
      toast.success("Saved");
    });
  }

  return (
    <div className="grid grid-cols-1 gap-6 lg:grid-cols-3 lg:items-start">
      <form onSubmit={handleSubmit} className="flex flex-col gap-4 lg:col-span-2">
        <FieldRow label="Title" htmlFor={`${idPrefix}-title`}>
          <input
            id={`${idPrefix}-title`}
            name="title"
            defaultValue={defaultValues.title}
            maxLength={200}
            disabled={pending}
            className={fieldInputClass}
          />
        </FieldRow>

        <div className="flex flex-col gap-1.5">
          {/* Not a `<label htmlFor>` — its target isn't a single labelable
              form control (Tiptap's contentEditable surface plus a row of
              toolbar buttons), so a plain heading avoids a dangling `for`
              reference to nothing. */}
          <span className="text-sm font-medium text-brand-dark">
            Body
            <span className="ml-0.5 text-destructive" aria-hidden="true">
              *
            </span>
          </span>
          {/* The editor itself has no native form control `FormData` can
              read — this hidden input is what actually submits `body`. */}
          <input type="hidden" name="body" value={body} />
          <RichTextEditor ref={editorRef} value={body} onChange={setBody} disabled={pending} />
        </div>

        <FieldRow
          label="Sort order"
          htmlFor={`${idPrefix}-sort-order`}
          hint="Lower numbers list first."
          className="max-w-40"
        >
          <input
            id={`${idPrefix}-sort-order`}
            name="sortOrder"
            type="number"
            min={0}
            step={1}
            defaultValue={defaultValues.sortOrder}
            disabled={pending}
            className={fieldInputClass}
          />
        </FieldRow>

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
          {pending ? "Saving…" : submitLabel}
        </Button>
      </form>

      <div className="flex flex-col gap-4">
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <h3 className="text-sm font-semibold text-brand-dark">Insert a placeholder</h3>
          <p className="mt-1 text-xs text-slate-500">Click a token to insert it at the cursor.</p>
          {allPlaceholderTokens.length === 0 ? (
            <p className="mt-2 text-sm text-slate-500">No placeholders available.</p>
          ) : (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {allPlaceholderTokens.map((token) => {
                const inUse = presentPlaceholders.includes(token);
                return (
                  <button
                    key={token}
                    type="button"
                    title={placeholders[token]}
                    disabled={pending}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => editorRef.current?.insertContent(`{{${token}}}`)}
                    className={
                      "focus-ring inline-flex items-center rounded-full border px-2.5 py-1 font-mono text-xs transition-colors disabled:pointer-events-none disabled:opacity-50 " +
                      (inUse
                        ? "border-brand/30 bg-brand/5 text-brand-dark"
                        : "border-slate-200 bg-white text-slate-600 hover:border-brand/30 hover:bg-brand/5")
                    }
                  >
                    {`{{${token}}}`}
                  </button>
                );
              })}
            </div>
          )}
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <h3 className="text-sm font-semibold text-brand-dark">Placeholders in this body</h3>
          {presentPlaceholders.length === 0 ? (
            <p className="mt-2 text-sm text-slate-500">No placeholders found.</p>
          ) : (
            <dl className="mt-3 flex flex-col gap-3">
              {presentPlaceholders.map((token) => (
                <div key={token}>
                  <dt className="font-mono text-xs text-brand-dark">{`{{${token}}}`}</dt>
                  <dd className="mt-0.5 text-xs text-slate-500">{placeholders[token]}</dd>
                </div>
              ))}
            </dl>
          )}
        </div>
      </div>
    </div>
  );
}
