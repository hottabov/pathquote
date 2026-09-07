"use client";

import { useRef, useState, useTransition, type FormEvent } from "react";
import { SectionCard } from "@/components/ui-kit";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui-kit/client";
import { RichTextEditor, type RichTextEditorHandle } from "@/components/ui-kit/rich-text-editor-lazy";
import { toEditorHtml } from "@/lib/rich-text-core";
import type { QuoteToken } from "@/lib/quote-variables";
import type { ActionResult } from "@/lib/actions/catalog";

/**
 * The category-level quote copy editor, shown to an admin above the series
 * image card (see `[seriesId]/page.tsx`). Saving here never navigates — the
 * admin stays on the same series page — so this follows `ContentBlockForm`'s
 * `useTransition` + manual `onSubmit` pattern rather than `useActionState`
 * (which `ProductForm` uses precisely because *its* save redirects): success
 * needs its own signal here, which a `useActionState` result alone can't give
 * without an extra effect watching for it to change.
 *
 * The rich text field follows `ProductForm`'s: `RichTextEditor` seeded once
 * through `toEditorHtml` (in case `defaultValue` is a legacy plain-text row),
 * carried to the server via a hidden `name="quoteDescription"` input since
 * the editor itself has no native form control for `FormData` to read.
 * `updateSeriesQuoteDescription` sanitizes on write, so this component
 * doesn't need to.
 */
export function SeriesQuoteDescriptionCard({
  seriesId,
  seriesName,
  defaultValue,
  tokens,
  action,
}: {
  seriesId: string;
  seriesName: string;
  defaultValue: string | null;
  tokens: QuoteToken[];
  action: (formData: FormData) => Promise<ActionResult>;
}) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [body, setBody] = useState(() => toEditorHtml(defaultValue ?? ""));
  const editorRef = useRef<RichTextEditorHandle>(null);
  const toast = useToast();
  const labelId = `series-quote-description-${seriesId}`;

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
    <SectionCard
      title="Quote description"
      description="Printed under every product of this category on a quote. Leave empty to print nothing."
    >
      <form
        onSubmit={handleSubmit}
        className="grid grid-cols-1 gap-6 lg:grid-cols-3 lg:items-start"
      >
        <div className="flex flex-col gap-1.5 lg:col-span-2">
          {/* Not a `<label htmlFor>` — same reasoning as ContentBlockForm's
              Body field: the target is Tiptap's contentEditable surface plus
              a toolbar, not one labelable control. Associated via
              `aria-labelledby` instead, scoped by `seriesId` so two series
              pages never collide if either ever renders more than one on a
              page. */}
          <span id={labelId} className="text-sm font-medium text-brand-dark">
            {seriesName} copy
          </span>
          {/* The editor has no native form control `FormData` can read —
              this hidden input is what actually submits `quoteDescription`. */}
          <input type="hidden" name="quoteDescription" value={body} />
          <div role="group" aria-labelledby={labelId}>
            <RichTextEditor ref={editorRef} value={body} onChange={setBody} disabled={pending} />
          </div>

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
            {pending ? "Saving…" : "Save changes"}
          </Button>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <h3 className="text-sm font-semibold text-brand-dark">Insert a variable</h3>
          <p className="mt-1 text-xs text-slate-500">
            Only variables this category has data for are listed — a category with no cutting
            height, for instance, never offers {"{{cutHeightCm}}"}.
          </p>
          {tokens.length === 0 ? (
            <p className="mt-2 text-sm text-slate-500">No variables available.</p>
          ) : (
            // The palette IS the documentation for what each token means, so
            // every chip shows its full source text rather than stashing it
            // in a `title` tooltip — a reader must be able to learn what
            // {{cutWidthCm}} means without hovering, and without it being
            // clipped. `min-w-0` + `overflow-wrap: anywhere` (via
            // break-words) on the source line is what keeps a long source
            // sentence from forcing the chip — or the card — wider than its
            // column instead of just wrapping.
            <ul className="mt-3 flex flex-col gap-2">
              {tokens.map((quoteToken) => (
                <li key={quoteToken.token}>
                  <button
                    type="button"
                    disabled={pending}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => editorRef.current?.insertContent(`{{${quoteToken.token}}}`)}
                    className="focus-ring flex w-full min-w-0 flex-col items-start gap-0.5 rounded-lg border border-slate-200 bg-white px-3 py-2 text-left transition-colors hover:border-brand/30 hover:bg-brand/5 disabled:pointer-events-none disabled:opacity-50"
                  >
                    <span className="font-mono text-xs text-brand-dark">{`{{${quoteToken.token}}}`}</span>
                    <span className="break-words text-xs text-slate-500">{quoteToken.source}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </form>
    </SectionCard>
  );
}
