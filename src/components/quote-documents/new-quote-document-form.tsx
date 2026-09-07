"use client";

import { useRef } from "react";
import { useRouter } from "next/navigation";
import { createQuoteDocument } from "@/lib/actions/quote-documents";
import type { ActionResult } from "@/lib/actions/quote-documents";
import type { QuoteToken } from "@/lib/quote-variables";
import { QuoteDocumentForm } from "./quote-document-form";

/**
 * The create half of `QuoteDocumentForm` — the same form an author already
 * knows from editing Terms, plus the key field, wired to
 * `createQuoteDocument` and to the navigation that follows a success.
 *
 * A wrapper rather than a branch inside the page because the page is a server
 * component and this needs two client-only things: the router, and somewhere
 * to keep the key the action returns. `createQuoteDocument` normalizes the
 * key (trims and lowercases it), so the URL to send the admin to is the one
 * the server decided on, not the one they typed — hence the ref, filled on
 * the way through and read by `onSuccess`.
 */
export function NewQuoteDocumentForm({
  sortOrder,
  tokens,
}: {
  /** The position the new document takes in the print order — last. */
  sortOrder: number;
  tokens: QuoteToken[];
}) {
  const router = useRouter();
  const createdKey = useRef<string | null>(null);

  async function action(formData: FormData): Promise<ActionResult> {
    const result = await createQuoteDocument(formData);
    createdKey.current = result.key ?? null;
    return result;
  }

  function handleSuccess() {
    const key = createdKey.current;
    // Straight to the new document's own editor, where region versions are
    // created — the next thing an admin adding an EU-only agreement wants.
    // `/documents` is the fallback for the impossible case of a success with
    // no key, so a created document is never left unreachable by a redirect
    // that had nowhere to go.
    router.push(key ? `/documents/${encodeURIComponent(key)}` : "/documents");
  }

  return (
    <QuoteDocumentForm
      action={action}
      idPrefix="quote-document-new"
      bodyLabel="Document"
      // A blank body, which `quoteDocumentSchema` refuses to save — a legal
      // document must not print empty. The admin writes it before the first
      // save, exactly as they would for a region version.
      defaultValues={{ title: "", body: "", includedByDefault: true }}
      tokens={tokens}
      createFields={{ sortOrder }}
      submitLabel="Create document"
      pendingLabel="Creating…"
      successMessage="Document created"
      onSuccess={handleSuccess}
    />
  );
}
