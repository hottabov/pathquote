"use client";

import { useState, useTransition } from "react";
import { Eye } from "lucide-react";
import { Button } from "@/components/ui/button";
import { RICH_TEXT_PROSE_CLASS } from "@/components/ui-kit/rich-text-prose";
import { previewQuoteDocument } from "@/lib/actions/quote-documents";
import { cn } from "@/lib/utils";

/**
 * "Preview with sample figures" — the document rendered the way a quote
 * renders it, with the eight `{{tokens}}` filled in.
 *
 * `getBody` rather than a `body` prop: on the editing side the thing worth
 * previewing is what the author has typed *this second*, not what was last
 * saved, and reading it on click keeps this component out of every keystroke's
 * render. On the read-only side the caller simply returns the stored body.
 *
 * The markup itself is produced by `previewQuoteDocument`, a server action.
 * Nothing here substitutes or sanitizes: this component receives HTML that
 * has already been through `renderStoredRichText`'s allowlist, which is what
 * makes the `dangerouslySetInnerHTML` below safe for a body that may predate
 * the write-boundary sanitizer. It is also what keeps a second, browser-side
 * copy of the substitution rules from existing at all — a preview that
 * disagreed with the printed quote would be worse than no preview.
 *
 * The sample figures are stated in words above the rendered text, not just
 * implied by it: an author reading "Delivery in 14 weeks" has to be able to
 * tell that 14 came from nowhere in particular.
 */
export function DocumentPreview({
  idPrefix,
  getBody,
}: {
  /** Scopes the panel's id — threaded from the caller rather than taken from
   * `useId`, the way every other id in this app's forms is, so an id stays
   * a readable, queryable string. */
  idPrefix: string;
  getBody: () => string;
}) {
  const [pending, startTransition] = useTransition();
  const [html, setHtml] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const panelId = `${idPrefix}-preview`;

  function handleToggle() {
    if (html !== null) {
      // Collapsing keeps nothing around: reopening re-renders from whatever
      // the body says by then, so a stale preview can never be on screen
      // beside an edited document.
      setHtml(null);
      setError(null);
      return;
    }
    setError(null);
    startTransition(async () => {
      const result = await previewQuoteDocument(getBody());
      if (result.error || !result.html) {
        setError(result.error ?? "Couldn't build the preview.");
        return;
      }
      setHtml(result.html);
    });
  }

  return (
    <div className="flex flex-col gap-3">
      <Button
        type="button"
        variant="outline"
        onClick={handleToggle}
        disabled={pending}
        aria-expanded={html !== null}
        // Only while the panel is actually in the DOM — a reference to an id
        // that does not exist is worse than no reference.
        aria-controls={html !== null ? panelId : undefined}
        className="h-11 w-full sm:w-auto sm:self-start"
      >
        <Eye className="size-4" data-icon="inline-start" aria-hidden="true" />
        {pending ? "Building preview…" : html !== null ? "Hide preview" : "Preview with sample figures"}
      </Button>

      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}

      {html !== null ? (
        <div id={panelId} className="rounded-xl border border-slate-200 bg-white p-4">
          {/* Said plainly, and before the text rather than after it. The
              figures below are not this quote's, are not any quote's, and an
              author who takes "14 weeks" for a real commitment has been
              misled by their own tool. */}
          <p className="text-xs text-slate-500">
            Sample figures, not a real quote: delivery 14 weeks, installation 2 days, training 3 days,
            warranty 12 months, quote Q-AU-2026-001 for Sample Client Pty Ltd, valid to 31/12/2026, with a
            placeholder bank block. A real quote fills each one from its own region and its own agreed terms.
          </p>
          <div className={cn("mt-3 max-w-[70ch] text-sm text-slate-700", RICH_TEXT_PROSE_CLASS)}>
            <div dangerouslySetInnerHTML={{ __html: html }} />
          </div>
        </div>
      ) : null}
    </div>
  );
}
