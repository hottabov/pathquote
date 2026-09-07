import { notFound } from "next/navigation";
import type { Metadata } from "next";
import { auth } from "@/auth";
import { isAdminRole } from "@/lib/roles";
import { getQuoteDocument } from "@/lib/queries/quote-documents";
import { DOCUMENT_TOKENS } from "@/lib/quote-variables";
import { renderStoredRichText } from "@/lib/rich-text";
import { PageHeader } from "@/components/ui-kit";
import {
  QuoteDocumentEditor,
  type QuoteDocumentVersion,
} from "@/components/quote-documents/quote-document-editor";

export const dynamic = "force-dynamic";

type Params = { key: string };

// Next.js decodes a dynamic route segment before handing it to `params`, so
// `key` here is already the raw document key ("terms", "conditions"), not its
// URL-encoded form — same as `/settings/content/[key]` before it. A quote
// document's key is constrained to `QUOTE_DOCUMENT_KEY_REGEX`
// (letters/digits/dots/hyphens) and so can never contain the `/` that made
// the catalogue route by opaque id instead.
export async function generateMetadata({ params }: { params: Promise<Params> }): Promise<Metadata> {
  const { key } = await params;
  // `getQuoteDocument` is request-memoized, so resolving it here and again in
  // the page body is one query, not two.
  // `quoteDocument`, not `document`: in this codebase `Document` is the quote
  // itself, so the shorter name would name the wrong thing.
  const quoteDocument = await getQuoteDocument(key);
  const title = quoteDocument?.default?.title ?? quoteDocument?.overrides[0]?.title;
  return { title: title ? `${title} — ${key}` : key };
}

/**
 * One whole quote document, with a tab per region.
 *
 * A MANAGER is NOT sent to `notFound()` here. `/settings/content/[key]` did
 * exactly that, which is why a salesperson could never read the terms their
 * own client was signing. They get the page, every region tab, and every
 * word — rendered, not editable. What the page withholds from them is the
 * editor, the variable palette, Save, and region create/delete, all of which
 * would fail against `requireAdmin()` server actions anyway; `canEdit` is
 * the single switch, read the same way `/catalog/[seriesId]` reads it.
 *
 * The read-only body is rendered HERE, on the server, through
 * `renderStoredRichText` — the same allowlist sanitizer every other stored
 * body goes through before reaching `dangerouslySetInnerHTML`. A document row
 * may predate that allowlist (or be legacy markdown), and doing this pass in
 * the browser would both trust the wrong side of the wire and drag
 * `isomorphic-dompurify` back into a client chunk it was deliberately taken
 * out of. An editing admin needs no such pass: their body goes into Tiptap,
 * which parses against its own schema and never hands anything to
 * `dangerouslySetInnerHTML`.
 */
export default async function QuoteDocumentPage({ params }: { params: Promise<Params> }) {
  const { key } = await params;
  const [session, quoteDocument] = await Promise.all([auth(), getQuoteDocument(key)]);

  // `null` only when the key names nothing at all. A key with region versions
  // but no global default is a region-only document (D5) and a perfectly real
  // result — the editor renders an explanatory Default tab for it rather than
  // a 404.
  if (!quoteDocument) notFound();

  const canEdit = isAdminRole(session?.user?.role);

  const versions: QuoteDocumentVersion[] = [];
  if (quoteDocument.default) {
    versions.push({
      regionCode: null,
      title: quoteDocument.default.title,
      body: quoteDocument.default.body,
      includedByDefault: quoteDocument.default.includedByDefault,
      bodyHtml: canEdit ? null : renderStoredRichText(quoteDocument.default.body),
    });
  }
  for (const override of quoteDocument.overrides) {
    versions.push({
      regionCode: override.regionCode,
      title: override.title,
      body: override.body,
      includedByDefault: override.includedByDefault,
      bodyHtml: canEdit ? null : renderStoredRichText(override.body),
    });
  }

  const heading = quoteDocument.default?.title ?? quoteDocument.overrides[0]?.title ?? key;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        backHref="/documents"
        backLabel="Documents"
        title={heading}
        description={
          canEdit
            ? key
            : `${key} — read-only. Only an admin can change what a customer signs.`
        }
      />

      <QuoteDocumentEditor
        documentKey={quoteDocument.key}
        versions={versions}
        activeRegions={quoteDocument.activeRegions.map((region) => ({ code: region.code, name: region.name }))}
        canEdit={canEdit}
        // The palette's own list, straight from the registry the save
        // validator checks against — an author is offered exactly the tokens
        // `updateQuoteDocument` will accept, and passing it from the server
        // keeps quote-variables.ts (and the zod it imports) out of the client
        // chunk, the same way `/catalog/[seriesId]` passes `categoryTokensFor`.
        tokens={DOCUMENT_TOKENS}
      />
    </div>
  );
}
