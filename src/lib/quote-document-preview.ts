// What a quote document looks like once its `{{tokens}}` are filled in —
// the "Preview" the /documents editor offers an author, and the read-only
// one a MANAGER gets on the same page.
//
// It runs the SAME two functions the quotation renderer runs, in the same
// order: `substitutePlaceholders` (which also strips a line whose token had
// no value, exactly as a real quote would) and then `renderStoredRichText`.
// There is deliberately no second substitution path — the whole point of a
// preview is that it cannot disagree with the printed quote about what the
// text does, only about which figures it prints.
//
// Server-side only in practice: `renderStoredRichText` pulls in
// `isomorphic-dompurify`, which the project keeps out of browser chunks (see
// src/components/builder/notes-section.tsx). The two callers are a server
// page and a server action; the client Preview button posts its body to the
// latter rather than rendering anything itself.

import { formatDateAU } from "./format";
import { substitutePlaceholders } from "./quotation-data";
import type { DocumentTokenName } from "./quote-variables";
import { renderStoredRichText } from "./rich-text";
import { formatBankDetails } from "./sheet-data";

/**
 * A fixed, obviously-invented value for each of the eight document tokens.
 *
 * Fixed rather than derived from any real quote or region: a preview opened
 * from the Documents section has no quote in hand, and picking some
 * arbitrary existing one would produce a page that looks authoritative about
 * a customer it has nothing to do with. Every figure here is the schema
 * default (14 / 2 / 3 / 12 — see `Region`'s columns), the date and quote
 * number are stated as samples in the UI beside the rendered text, and the
 * client and bank are named "Sample" outright so nothing in the output can
 * be mistaken for a real party's details.
 *
 * Keyed by `DocumentTokenName`, so a token added to the registry without a
 * sample value here fails to compile — the same totality guarantee
 * `buildQuotationData`'s own document `vars` has.
 */
export const DOCUMENT_PREVIEW_SAMPLE: Record<DocumentTokenName, string> = {
  deliveryWeeks: "14",
  installationDays: "2",
  trainingDays: "3",
  warrantyMonths: "12",
  // Through the same formatter the renderer uses for `{{bankDetails}}`, so
  // the preview shows the real "Label: value" per line shape rather than a
  // hand-written approximation of it.
  bankDetails: formatBankDetails([
    { label: "Bank", value: "Sample Bank" },
    { label: "Account name", value: "Sample Account Name" },
    { label: "BSB", value: "000-000" },
    { label: "Account number", value: "0000 0000" },
    { label: "SWIFT", value: "SAMPLEAU0XXX" },
  ]),
  // A constant date, not `new Date()` + 30 days: a preview that reads
  // differently every time it is opened invites an author to trust it as a
  // real figure. Same formatter (`formatDateAU`) the quote itself uses.
  validityDate: formatDateAU(new Date(2026, 11, 31)),
  quoteNumber: "Q-AU-2026-001",
  clientName: "Sample Client Pty Ltd",
};

/**
 * `body` (HTML from the editor, or a legacy markdown row) rendered exactly
 * as a quote would render it, with `DOCUMENT_PREVIEW_SAMPLE` standing in for
 * the quote's own figures. `renderStoredRichText` sanitizes, so the result
 * is safe for `dangerouslySetInnerHTML`.
 */
export function renderQuoteDocumentPreview(body: string): string {
  return renderStoredRichText(substitutePlaceholders(body, DOCUMENT_PREVIEW_SAMPLE));
}
