// Pure assembly for the extended quotation renderer (Phase 6): turns a
// loaded document plus its region's `QuoteDocument` rows into `QuotationData`,
// the flat shape `QuotationSheet` (src/components/sheet/quotation-sheet.tsx)
// renders. Mirrors src/lib/sheet-data.ts's discipline exactly — no
// `@/lib/db` or `next/*` imports, so a plain `vitest run` of this file never
// needs `DATABASE_URL` set — and reuses `toSheetData` for everything a
// quotation shares with the plain document sheet (entity/client header,
// investment-summary items+totals). The input types below are declared from
// scratch (not imported from src/lib/queries/documents.ts) for the same
// reason `ToSheetDataDoc` is: TypeScript's structural typing means the real
// `DocumentForBuilder` satisfies `QuotationDataDoc` without either file
// importing the other, as long as `DocumentForBuilder`'s items carry the
// extra fields (`kind`, `specs`, `seriesQuoteDescription`, `seriesName`,
// `seriesId`, `serialNumber`) this module needs.
import type { OptionRole, ProductKind } from "@prisma/client";
import { z } from "zod";
import { formatDateAU, formatMoney } from "./format";
import { machineSpecSentence, extraSpecVars } from "./machine-specs";
// The one formatter for a metre total ("4.8 m", "6 m") — see its doc comment;
// it exists for exactly this, and the options editor already prints the same
// running total beside a module's quantity stepper. Pure, no imports at all.
import { formatMetres } from "./option-length";
import { renderStoredRichText } from "./rich-text";
// The client-safe half of the rich-text seam (no `isomorphic-dompurify`, no
// `next/*`, no `@/lib/db`) — this module already reaches it transitively
// through `./rich-text`, so importing it directly adds no dependency and
// keeps this file's purity rule (see the header comment) intact.
import { isHtmlContent } from "./rich-text-core";
// The token registry — pure by the same rule as this module. `tokensIn` is
// imported rather than re-derived so "what counts as a token" has exactly one
// definition shared by the editor palette, the save validator and this
// renderer.
import { tokensIn, type CategoryTokenName, type DocumentTokenName } from "./quote-variables";
// Quote-then-region precedence for the four standard-terms figures, in one
// place shared by this renderer and the builder panel that sets them. Pure by
// the same rule as this module.
import { resolveQuoteTerms, type QuoteTermValues } from "./quote-terms";
import { readProductSpecs } from "./validation/product-specs";
import {
  dedupeDescription,
  formatBankDetails,
  toSheetData,
  type DocSheetClient,
  type DocSheetDelivery,
  type DocSheetData,
  type DocSheetEntity,
  type DocSheetItem,
  type DocSheetLine,
  type DocSheetPreparedBy,
  type DocSheetTotals,
  type ImageResolver,
  type ToSheetCompanyInput,
  type ToSheetContactInput,
  type ToSheetDataDoc,
  type ToSheetItemInput,
  type ToSheetLineInput,
} from "./sheet-data";
import { identityResolver } from "./sheet-identity";

// --- input shape -------------------------------------------------------------

export type QuotationLineInput = ToSheetLineInput & {
  kind: "OPTION" | "PRODUCT" | "CUSTOM";
  /** `DocumentLine.attributes` (e.g. `{ metres: 4, tables: 2 }`) — printed
   * verbatim as the row's `attributesLine`. These used to double as
   * `{{metres}}`/`{{tables}}` substitution vars for an `option.*` content
   * block; those blocks are gone (an option row describes itself from
   * `Option.shortDescription`, snapshotted onto the line), so the attributes
   * are display data only now and no token anywhere resolves from them. */
  attributes: Record<string, string | number> | null;
  /** The line's option's `Option.imageUrl` (resolved by `refId` — see
   * `getDocumentForBuilder`'s `optionImageMap`), snapshotted from the
   * catalog at read time rather than frozen on the line itself (an option's
   * icon can be added/changed in the catalog after the line was added, same
   * treatment as an item's own `imageUrl`). `null` for a PRODUCT/CUSTOM line
   * or an OPTION with no catalog image — the unified options table (see
   * `QuotationOptionRow.icon`) simply renders no icon cell content then. */
  imageUrl: string | null;
  /** The line's option's `Option.role`, resolved live by `refId` exactly as
   * `imageUrl` above is (see `getDocumentForBuilder`'s `optionRowMap`). What
   * tells an EasyLoader's table modules apart from every other option on the
   * item, and so what `tableLengthM` below sums over. `null` for a line with
   * no `refId`, an option with no role, or any non-OPTION line. */
  role: OptionRole | null;
  /** The line's option's `Option.unitLengthM` — the metres one unit of this
   * option adds (1.2 for an EasyLoader module, 1 for a metre of MTS travel).
   * Resolved live alongside `role`, and converted from Prisma's `Decimal` at
   * the query boundary the way every other decimal in `DocumentForBuilder`
   * is. `null` for an option sold by the piece, which is most of them. */
  unitLengthM: number | null;
};

export type QuotationItemInput = ToSheetItemInput & {
  /** `DocumentItem.serialNumber` — recorded post-installation and printed by
   * the production forms. Nothing in the quotation renderer reads it any more
   * (the RSP coverage table it used to fill is gone — see D10 in
   * docs/superpowers/specs/2026-09-07-quote-documentation-design.md); it stays
   * on the input type because `DocumentForBuilder` carries it and structural
   * typing costs nothing for a field this module ignores. */
  serialNumber: string | null;
  /** `Product.kind` — what decides whether the item is a cutting machine, and
   * so whether it gets a spec sentence. ACCESSORY for a snapshot item whose
   * product no longer resolves. */
  kind: ProductKind;
  /** The item's product's `Series.name` (e.g. "M-Series", "X-Calibre") —
   * display only, the prose `machineSpecSentence` opens with. `null` for a
   * snapshot item whose product no longer resolves a series. */
  seriesName: string | null;
  /** The item's product's `Series.id`. Not display data: it is what lets the
   * draft banner link a stripped token straight to the editor that owns the
   * copy (`/catalog/<seriesId>`) instead of naming a category the reader then
   * has to go and find. `null` for a snapshot item whose product no longer
   * resolves a category — the banner then names the category without linking
   * it rather than linking to `/catalog/null`. */
  seriesId: string | null;
  /** `Product.specs` exactly as stored (opaque `Json?`) — validated
   * defensively at runtime via `readProductSpecs`, same treatment as
   * `entitySnapshot`/`bankDetails` in sheet-data.ts. */
  specs: unknown;
  /** `Series.quoteDescription` — the copy authored once for this item's
   * category, printed under the item's heading with this product's own
   * figures substituted in. `null` or empty prints nothing, which is what a
   * category nobody has written copy for does. Replaces the per-product key
   * into the ContentBlock table that both went in z37_drop_content_block. */
  seriesQuoteDescription: string | null;
  lines: QuotationLineInput[];
};

/** Same shape as `ToSheetDataDoc` plus the extra fields needed for the
 * quotation renderer: `regionId` (to resolve a region's own version of a
 * document), richer `items` (see `QuotationItemInput`), and the two
 * quotation-first pricing-display toggles (see `setPriceDisplay` in
 * src/lib/actions/documents.ts) that gate per-item/per-option amounts in
 * the investment summary and the `{{price}}` token in a category's quote
 * copy — the grand total itself is never gated by either flag. */
export type QuotationDataDoc = Omit<ToSheetDataDoc, "items"> & {
  regionId: string;
  items: QuotationItemInput[];
  showItemPrices: boolean;
  showOptionPrices: boolean;
  /** The document's region's own standard-terms figures (`Region.deliveryWeeks`
   * and its three siblings) — the fallback for each of the four overrides
   * below. A region is effectively its own company, with its own lead times
   * and warranty, which is why these are not constants in this file any more. */
  region: QuoteTermValues;
  /** Per-quote overrides of the four figures above — `null` means inherit the
   * region's. Delivery and warranty are negotiated per deal, so a quote may
   * legitimately promise something other than its region's default (and `0`
   * is one of the things it may promise — see `resolveQuoteTerms`). */
  deliveryWeeks: number | null;
  installationDays: number | null;
  trainingDays: number | null;
  warrantyMonths: number | null;
  /** `DocumentExclusion.quoteDocumentKey` for this quote — the documents its
   * author unticked. Keys, not ids, so an exclusion still means the same
   * thing if the quote's region changes and a different `QuoteDocument` row
   * becomes the resolved one. Empty is the common case. */
  excludedDocumentKeys: string[];
  /** `Document.documentsSnapshot` exactly as stored (an opaque `Json?` column
   * written by `finalizeDocument`) — `unknown` for the same reason
   * `entitySnapshot` is: Prisma gives no compile-time guarantee about its
   * contents, so this module validates it at runtime (see
   * `readDocumentsSnapshot`) and falls back to live text when it does not
   * parse. `null` on a DRAFT and on any quote finalised before the column
   * existed. */
  documentsSnapshot: unknown;
  /** `Document.signatures` — at most one row per `SignerRole` (see the
   * `@@unique([documentId, role])` constraint on the `Signature` model).
   * Resolved into `QuotationData.signatures` below; an empty array (nobody
   * has signed yet) is what makes an untouched quote print unchanged from
   * before this feature — see `Signatures` in
   * src/components/sheet/sections/signatures.tsx. */
  signatures: {
    role: "AUTHOR" | "CLIENT";
    imageUrl: string;
    signerName: string;
    signedAt: Date;
  }[];
};

/** A `QuoteDocument` row exactly as stored — `regionId: null` is the global
 * default, a non-null `regionId` is that region's own version of the same
 * `key` (enforced by the `@@unique([key, regionId])` constraint). A row may
 * exist for a region with NO global default at all: that is a region-only
 * document, e.g. a Data Processing Agreement offered by an EU entity. */
export type QuoteDocumentRow = {
  key: string;
  regionId: string | null;
  title: string;
  body: string;
  sortOrder: number;
  includedByDefault: boolean;
};

// --- resolveQuoteDocuments ---------------------------------------------------

/**
 * Reduces every `QuoteDocument` row visible to a region (defaults + every
 * region's own versions — see `getQuoteDocumentsForRegion`) down to one row
 * per key for `regionId`: that region's own version when one exists,
 * otherwise the global default. Rows for a *different* region are ignored
 * entirely (they must never shadow a default some other region has not
 * replaced). Implemented as two passes — defaults first, then this region's
 * — so a region version always wins regardless of array order.
 *
 * A key present ONLY in the second pass is not a mistake: a region-only
 * document has no default to override, and the pass structure includes it
 * for its own region and no other.
 */
export function resolveQuoteDocuments(rows: QuoteDocumentRow[], regionId: string): Map<string, QuoteDocumentRow> {
  const resolved = new Map<string, QuoteDocumentRow>();

  for (const row of rows) {
    if (row.regionId !== null) continue;
    resolved.set(row.key, row);
  }

  for (const row of rows) {
    if (row.regionId !== regionId) continue;
    resolved.set(row.key, row);
  }

  return resolved;
}

// --- documentsSnapshot -------------------------------------------------------

/**
 * What `finalizeDocument` freezes onto `Document.documentsSnapshot`: every
 * rendered document body and every item's category copy, with placeholders
 * already substituted. Fixing a typo in General Conditions must not rewrite
 * the PDF of a quote signed three months ago.
 *
 * `version` is a literal `1` so a future shape can be told apart from this
 * one by parsing rather than by guessing, and an older writer's blob simply
 * fails to parse here instead of being half-read.
 */
const documentsSnapshotSchema = z
  .object({
    version: z.literal(1),
    documents: z.array(z.object({ key: z.string(), title: z.string(), bodyHtml: z.string() })),
    /** `DocumentItem.id` -> that item's frozen category copy. An item with no
     * copy at the time of finalising simply has no entry, which is why a
     * missing key falls back to live rather than printing nothing. */
    itemCopyHtml: z.record(z.string(), z.string()),
  })
  .strict();

export type DocumentsSnapshot = z.infer<typeof documentsSnapshotSchema>;

/**
 * Reads `Document.documentsSnapshot` defensively: a null column, a blob from
 * an older version of this app, or a hand-edited one that fails validation
 * all read as "no snapshot" so the caller falls back to live text. Same
 * treatment `readProductSpecs` gives `Product.specs` and `parseEntitySnapshot`
 * gives `entitySnapshot` — a malformed snapshot must never throw inside the
 * render of a customer-facing quote.
 */
export function readDocumentsSnapshot(raw: unknown): DocumentsSnapshot | null {
  if (raw === null || raw === undefined) return null;
  const parsed = documentsSnapshotSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

// --- substitutePlaceholders ------------------------------------------------

const PLACEHOLDER_PATTERN = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/**
 * Sentinel a caller passes as a var's value to explicitly withhold a token
 * — e.g. `{{price}}` in a machine title block when neither price-display
 * toggle is on (see `buildQuotationData`). Distinguishes "this token is
 * deliberately hidden right now" from a token with no entry in `vars` at
 * all (a genuinely-unresolved one, e.g. `{{rspYear2Cost}}`, which this
 * module simply has no data source for) only in the caller's intent —
 * `substitutePlaceholders` treats the two identically.
 */
export const OMIT = Symbol("quotation-data.OMIT");

export type PlaceholderVars = Record<string, string | typeof OMIT>;

// A value that can never legitimately appear in a content block's own
// authored text, used to mark a substituted-in token as unresolved so the
// line-strip pass below can find it after substitution has already run.
const UNRESOLVED_MARKER = "@@QUOTATION_UNRESOLVED@@";

/** Stand-in substituted for `{{price}}` in the throwaway second pass that
 * asks whether the category copy's own price line survived stripping — see
 * `hasInlinePrice` in `buildQuotationData`. Never reaches any rendered
 * output. Same "can never appear in authored text" rule as the marker above. */
const INLINE_PRICE_PROBE = "@@QUOTATION_INLINE_PRICE@@";

/** Leaf blocks: they hold text directly and wrap no other block, so a
 * newline after the closing tag is enough to give each one its own line.
 * Kept in step with `ALLOWED_TAGS` in rich-text-core.ts — the inline tags
 * there (`strong`, `em`, `a`, `br`, ...) are deliberately absent, since an
 * inline tag never ends a line. */
const BLOCK_CLOSE_PATTERN = /(<\/(?:p|h2|h3|li)>)/gi;
/** Containers: `<ul>`, `<ol>` and `<blockquote>` wrap other blocks rather
 * than being one, so their own tags need lines of their own — otherwise the
 * opener rides on the first child's line and gets deleted with it, leaving
 * the closer orphaned. */
const CONTAINER_OPEN_PATTERN = /(<(?:ul|ol|blockquote)\b[^>]*>)/gi;
const CONTAINER_CLOSE_PATTERN = /(<\/(?:ul|ol|blockquote)>)/gi;
/** A container left holding nothing once its children were stripped. */
const EMPTY_CONTAINER_PATTERN = /<(ul|ol|blockquote)\b[^>]*>\s*<\/\1>/gi;

/**
 * Splits an HTML body into one line per block-level element, so the strip
 * below can remove a single paragraph or list item instead of the whole
 * document. Tiptap serialises a document as one unbroken line — the `\n` the
 * markdown-era strip relied on simply is not there.
 *
 * A newline goes after every closing leaf-block tag, after every opening
 * container tag, and on BOTH sides of every closing container tag. That
 * placement is what keeps a container's own tags off its children's lines:
 * `<ul><li>A</li><li>B {{x}}</li></ul>` becomes the four lines `<ul>`,
 * `<li>A</li>`, `<li>B {{x}}</li>`, `</ul>`, so dropping the third leaves
 * the `<ul>`/`</ul>` pair around the item that survived rather than an
 * orphaned opener. The inserted newlines are whitespace between tags, which
 * the sanitizer and the browser both ignore.
 *
 * The one shape this cannot divide cleanly is a list item holding both its
 * own text and a nested list — `<li>A {{x}}<ul>…` — where the item's opening
 * tag has no choice but to share a line with the text an unresolved token
 * would take. Stripping there leaves a stray `</li>`, which
 * `sanitizeRichText` drops (every read of this output goes through
 * `renderStoredRichText`, which re-parses and re-serialises), so the page
 * still receives valid markup and the nested items are promoted into the
 * parent list rather than lost. Dividing it properly needs a real HTML
 * parser, which this pure module has no business carrying for a shape the
 * editor's own toolbar makes rare.
 */
function htmlBlockLines(html: string): string[] {
  return html
    .replace(CONTAINER_OPEN_PATTERN, "$1\n")
    .replace(CONTAINER_CLOSE_PATTERN, "\n$1\n")
    .replace(BLOCK_CLOSE_PATTERN, "$1\n")
    .split("\n");
}

/** "" for a value with no visible content left, so the caller's `text ? ... :
 * null` test means "is there anything to print" rather than "is the string
 * non-empty" — a body stripped down to the newlines `htmlBlockLines` inserted
 * would otherwise be truthy. */
function emptyToBlank(html: string): string {
  return html.trim() === "" ? "" : html;
}

/**
 * Replaces every `{{token}}` in `body` with `vars[token]`, then strips (in
 * full) any output line that still contains an unresolved or explicitly
 * `OMIT`-ed token. The owner's rule (raw "____" blanks scattered through a
 * customer-facing quotation are unacceptable — fields must fill themselves
 * in automatically) means this module never prints a fill-in-the-blank
 * marker any more: a line whose only content was a figure with no data
 * source (or one the caller deliberately withheld, like a hidden
 * `{{price}}`) simply doesn't exist in the rendered output.
 *
 * The strip runs on the raw stored source, one block at a time, *before*
 * `renderStoredRichText` ever sees it — so a whole paragraph/list-item/
 * heading disappears cleanly instead of leaving a dangling `<p>`/`<li>` with
 * blank content. What counts as a block depends on the body's shape:
 *
 *  - legacy markdown, where every paragraph, list item and heading already
 *    sits on its own line: one `\n`-delimited line, exactly as before;
 *  - HTML from the Tiptap editor, which serialises an entire document as a
 *    single line with no newlines in it at all: one block-level element,
 *    via `htmlBlockLines`. Splitting such a body on `\n` gave one line, so
 *    a single unresolved token anywhere in a category's copy used to delete
 *    the whole description rather than the sentence that needed the figure.
 *
 * A resolved multi-line value (e.g. `{{bankDetails}}` — see
 * `formatBankDetails`) substitutes in as-is, embedded `\n`s and all, so each
 * of its own lines becomes its own output line exactly as if they'd been
 * written directly into the block body.
 */
export type SubstitutionReport = {
  /** The body after substitution and line-stripping. */
  text: string;
  /** Distinct tokens that had no value and so cost their line, in first-seen
   * order. A token withheld with `OMIT` is deliberate and never listed — see
   * the draft banner in the quotation preview, which exists to surface a
   * missing figure, not a hidden price. */
  stripped: string[];
};

/** `substitutePlaceholders` plus a record of what went missing. */
export function substituteWithReport(body: string, vars: PlaceholderVars): SubstitutionReport {
  const stripped: string[] = [];

  const substituted = body.replace(PLACEHOLDER_PATTERN, (_match, token: string) => {
    const value = vars[token];
    if (value === OMIT) return UNRESOLVED_MARKER;
    if (value === undefined || value === "") {
      if (!stripped.includes(token)) stripped.push(token);
      return UNRESOLVED_MARKER;
    }
    return value;
  });

  // Which shape the AUTHORED body is, not the substituted one: a resolved
  // value could contain a tag of its own and must not change how the body it
  // sits in is divided into lines.
  const isHtml = isHtmlContent(body);
  const kept = (isHtml ? htmlBlockLines(substituted) : substituted.split("\n")).filter(
    (line) => !line.includes(UNRESOLVED_MARKER)
  );
  const joined = kept.join("\n");
  // On the HTML path, drop a container whose every child was stripped (an
  // empty bullet box is not what the author wrote) and report a document
  // reduced to nothing but the newlines this function inserted as empty, so
  // `titleBlockHtml` ends up `null` rather than blank markup. The markdown
  // path is left exactly as it was — its output is asserted character for
  // character by the pre-existing tests above.
  const text = isHtml ? emptyToBlank(joined.replace(EMPTY_CONTAINER_PATTERN, "")) : joined;

  return { text, stripped };
}

export function substitutePlaceholders(body: string, vars: PlaceholderVars): string {
  return substituteWithReport(body, vars).text;
}

// --- buildQuotationData ----------------------------------------------------

/**
 * One row of the machine section's unified options table (owner: "table
 * with small icons — більше контролю ніж списком" — replaces the old
 * two-tier optionBlocksHtml-paragraphs + fallbackOptions-bullets split,
 * which rendered inconsistently — prose for a matched `option.*` block,
 * bold indented lines for an unmatched one — and drifted visually against
 * each other). EVERY selected OPTION line produces exactly one row here,
 * whether or not its option has a content block, so no selected option is
 * ever silently omitted (same owner rule the old fallback list enforced).
 */
export type QuotationOptionRow = {
  id: string;
  /** Resolved via the same `ImageResolver` `buildQuotationData` uses for
   * item thumbnails/logo (identity for the in-app preview, `fileImageResolver`
   * for the PDF pipeline) — `null` when the option has no catalog image
   * (`QuotationLineInput.imageUrl`) or resolution failed, in which case the
   * sheet renders a blank icon cell rather than a broken image. */
  icon: string | null;
  /** `null` when redundant with `name` — equal to it, or one contains the
   * other (see `dedupeOptionCode`) — so the sheet never prints duplicate
   * text like "1.0mm dia punch — 1.0mm dia punch" or "Drills included
   * 2301071-7-10 — 2301071-7-10". Non-null renders as a mono prefix before
   * `name`. */
  code: string | null;
  name: string;
  /** Rendered HTML for the description under the option's name: the line's
   * own snapshot `description` (taken from `Option.shortDescription` when the
   * option was added), deduped against `name` via `dedupeDescription` the
   * same way an item/extra-line description is — `null` when the option
   * carries none, or when it only repeats the name. There is no second
   * source any more: the `option.*` content blocks that used to supply this
   * are gone, and an option already describes itself in the catalog. */
  descriptionHtml: string | null;
  /** Flattened `line.attributes` as one small line, e.g. "metres: 4 ·
   * tables: 2" — `null` when the line carries no attributes. */
  attributesLine: string | null;
  qty: number;
  /** `formatMoney`-formatted line total, gated by `showOptionPrices` — the
   * sheet hides the whole price column when this toggle is off rather than
   * rendering blank cells (see `QuotationSheet`). */
  price: string | null;
};

/**
 * `code` when it's genuinely distinct information from `name`, else `null`
 * — an option is frequently catalogued with its code doubling as (or fully
 * embedded in) its name (e.g. code "2301071-7-10", name "Drills included
 * 2301071-7-10"), and printing both verbatim renders a visible duplicate.
 * Broader than a plain equality check (equal either way, or either string
 * containing the other) so it also catches the "name embeds the code as a
 * suffix" shape those two owner-reported examples both are, not just an
 * exact code===name match.
 */
export function dedupeOptionCode(code: string | null, name: string): string | null {
  if (!code) return null;
  const c = code.trim();
  const n = name.trim();
  if (c === "" || c === n || n.includes(c) || c.includes(n)) return null;
  return code;
}

/**
 * `DocSheetItem` plus its description rendered to HTML — the investment
 * summary's counterpart to `QuotationOptionRow.descriptionHtml` (same
 * reasoning: `DocumentItem.description` is a snapshot of the catalogue
 * product's own `description`, which — since the `RichTextEditor` replaced
 * ProductForm's plain textarea — can carry admin-authored markup, not just
 * plain text). `description` itself stays on the type (inherited from
 * `DocSheetItem`) rather than being replaced, so `toSheetData`'s own tests
 * (which assert the raw, deduped string) are unaffected; only the sheet
 * renders `descriptionHtml` now — see quotation-sheet.tsx.
 */
export type QuotationItemRow = DocSheetItem & {
  /** `renderStoredRichText(description)` — sanitizes already-HTML content
   * (the common case, once a product's description has been saved through
   * the editor at least once) or runs legacy plain-text/markdown through
   * `renderMarkdown` (a description nobody has re-saved since the editor
   * shipped). `null` exactly when `description` is `null` (already deduped
   * against the item's `name` by `toSheetData`). */
  descriptionHtml: string | null;
};

export type QuotationMachineSection = {
  itemId: string;
  /** The section's heading text — ALWAYS present, one consistent tier
   * (`.pq-product-title` in quotation-sheet.tsx) for every machine/
   * equipment/software/service item, and ALWAYS the item's own `name`. A
   * category has no title of its own to compete with it: the old rule (trust
   * a matched content block's `title` when it was DYNAMIC, i.e. carried a
   * `{{` placeholder; ignore a STATIC one like the generic "Easy-Loader #1")
   * existed only because block titles could carry the wrong product's name.
   * Nothing can carry a wrong name any more. The item's code renders
   * alongside this separately, as a muted mono suffix — see
   * quotation-sheet.tsx. */
  sectionTitle: string;
  /** The item's category copy (`QuotationItemInput.seriesQuoteDescription`)
   * rendered to HTML, with `{{model}}`/`{{price}}`/`{{cutHeightCm}}`/
   * `{{cutWidthCm}}`/`{{specSentence}}` substituted — `null` when the
   * category has no copy, or when every line of it was stripped for want of
   * a figure, in which case the sheet renders `specSentence` (alongside
   * `sectionTitle` and the item's price from `lineSummary`) as a minimal
   * auto-generated section instead — see quotation-sheet.tsx. Carries no
   * top-level heading of its own (that's `sectionTitle`'s job, rendered once,
   * consistently, outside this HTML). */
  titleBlockHtml: string | null;
  /** One-line spec summary from `Product.specs` (see `machineSpecSentence`
   * in src/lib/machine-specs.ts) — e.g. "M-Series Cutting Machine, 3cm
   * compressed lay height, 390cm cutting width". `null` for anything that
   * is not a cutting machine (`kind !== "MACHINE"`), or a machine with no
   * width recorded. */
  specSentence: string | null;
  /** The item's total (incl. options), currency-formatted — same figure as
   * the `{{price}}` token substituted into `titleBlockHtml`, but exposed
   * structurally so the sheet can print it under the section heading for
   * EVERY section, not just one whose matched block happens to reference
   * `{{price}}` inline (owner: several sections — EL-2020, PTW(I), FP-180 —
   * showed no price at all, because their content blocks simply never
   * carried a "Price: {{price}}" line the way machine.m-series's did).
   * `null` when neither price-display toggle is on. See `hasInlinePrice`
   * for when the sheet should print this vs. rely on the copy's own inline
   * line instead. */
  sectionPrice: string | null;
  /** `true` when the category's own (pre-substitution) copy already contains
   * a literal `{{price}}` token — i.e. it prints its own price line as part
   * of `titleBlockHtml` (the way the old machine.m-series block's "**Price:
   * {{price}}**" did). The sheet uses this to avoid printing `sectionPrice` a
   * second time for that section, while every other section (whose copy has
   * no such line, or which has no copy at all) gets it structurally. Always
   * `false` for a category with no copy. */
  hasInlinePrice: boolean;
  /** One row per selected OPTION line on this item, in a single unified
   * table (see `QuotationOptionRow`) — replaces the old optionBlocksHtml/
   * fallbackOptions two-tier split; every OPTION line lands here, described
   * by its own snapshot description. */
  optionRows: QuotationOptionRow[];
  /** The machine itself, as the first row of its own options table (owner:
   * the customer should read the product and its base price at the top of
   * that list, then what was added to it — finding the base price only in
   * the Investment Summary reads as if the options were the whole quote).
   * Priced by the same `showOptionPrices` toggle the option rows use, so
   * the whole table hides or shows its money together.
   *
   * `null` for a product whose price is carried entirely by the option rows
   * beneath it (`ItemBreakdown.assembledFromOptions` — an EasyLoader): the
   * row would repeat the machine's own name back at the customer with a
   * misleading "$0" beside it. The table is never left empty by this, because
   * that flag is only ever set when there are option rows to carry it. */
  baseRow: QuotationBaseRow | null;
  /** This item's own row from `DocSheetData.items` (name/price/lines/total)
   * — reused as-is for the investment-summary table rather than
   * recomputed. */
  lineSummary: DocSheetItem;
};

export type QuotationBaseRow = {
  /** `null` when the code is already the leading word of `name`, so the
   * sheet doesn't print "X-10180 — X-10180 Cutting System" — same
   * `dedupeOptionCode` rule the option rows follow. */
  code: string | null;
  name: string;
  qty: number;
  /** Currency-formatted base price; `null` when option prices are hidden, and
   * also when the product has no price of its own to quote
   * (`ItemBreakdown.basePriceUnquoted` — Service, or a not-yet-assembled
   * EasyLoader). The renderer prints nothing in either case, so it never has
   * to know which of the two silenced it. */
  price: string | null;
};

/** One whole legal document as it prints: its own authored heading and one
 * body of already-substituted, already-sanitized HTML. The shape the
 * `documentsSnapshot` stores too, so what a FINAL quote replays is exactly
 * what its preview showed. */
export type QuotationDocumentSection = { key: string; title: string; bodyHtml: string };

/**
 * One token that cost its line, and enough about where it happened for a
 * reader to act on it.
 *
 * A bare token name was not actionable: a quote holding an M-Series machine,
 * an EasyLoader and a spreader is three plausible categories, and
 * "`{{cutHeightCm}}` has no value — edit the category's quote description"
 * named none of them. Every field here exists to answer "which one do I
 * open?".
 */
export type StrippedCopyToken = {
  /** The token itself, without braces — e.g. `cutHeightCm`. */
  token: string;
  /** The item whose copy lost the line, e.g. "L-220 Cutting Machine". The
   * item, not the product: this is the name printed on the quote, so the
   * reader can find the section that is missing a sentence. */
  itemName: string;
  /** `Series.name` of the category that owns the copy — what the banner
   * groups by, since one category's copy is one thing to go and edit however
   * many items on the quote came out of it. `null` for a snapshot item whose
   * product no longer resolves a category. */
  seriesName: string | null;
  /** `Series.id`, so the banner can link straight to the editor. `null` for a
   * snapshot item whose product no longer resolves a category. */
  seriesId: string | null;
};

/**
 * The document-scope counterpart of `StrippedCopyToken`: one token that cost
 * its line out of a legal document's body, and where to go and fix it.
 *
 * A parallel type rather than a widened `StrippedCopyToken` with a
 * discriminant, because the two share exactly one field. A document strip has
 * no item and no category — all three of `itemName`, `seriesName` and
 * `seriesId` would become meaningless here, and every existing reader of
 * `StrippedCopyToken` would have to start narrowing a union to keep reading
 * the fields it reads today. Two small total types, each answering "which one
 * do I open?" for its own scope, cost the banner one more list and cost the
 * type nothing.
 */
export type StrippedDocumentToken = {
  /** The token itself, without braces — e.g. `clientName`. */
  token: string;
  /** `QuoteDocument.key`, so the banner can link to `/documents/<key>`. */
  documentKey: string;
  /** The document's printed heading, e.g. "Terms" — what the banner names,
   * since that is what the reader sees on the quote and in the Documents
   * list. */
  documentTitle: string;
};

export type QuotationData = {
  isDraft: boolean;
  number: string | null;
  issueDate: string;
  validityDate: string | null;
  logo: string | null;
  /** See `DocSheetData.heroImage` — carried straight through from
   * `toSheetData`, same as `logo`. */
  heroImage: string | null;
  entity: DocSheetEntity;
  client: DocSheetClient | null;
  /** See `DocSheetDelivery` — carried straight through from `toSheetData`,
   * same as `client`. */
  delivery: DocSheetDelivery | null;
  /** The document's author, for the header's "Prepared by" column — see
   * `DocSheetPreparedBy`. Relabels the existing `client` block "Prepared
   * for" alongside it (see quotation-sheet.tsx). */
  preparedBy: DocSheetPreparedBy;
  /** `Document.notes`, rendered to HTML via `renderStoredRichText` — `null` when
   * there's nothing to show, in which case the sheet renders no Notes
   * section at all. */
  notesHtml: string | null;
  machineSections: QuotationMachineSection[];
  /** Category-copy tokens that had no value on this quote, so their line was
   * removed — each one attributed to the item it happened on and the category
   * whose copy owns it. The draft preview lists them; the FINAL PDF ignores
   * them. */
  strippedTokens: StrippedCopyToken[];
  /** The same report for the DOCUMENT scope — tokens that had no value in a
   * legal document's body, so their clause was removed, each attributed to
   * the document to open. Empty for a quote rendering from its snapshot: a
   * frozen body was substituted once, on the day it was signed, and nothing
   * is stripped from it now. */
  strippedDocumentTokens: StrippedDocumentToken[];
  items: QuotationItemRow[];
  extraLines: DocSheetLine[];
  totals: DocSheetTotals;
  /** Every legal document this quote includes, in the print order an admin
   * set (`QuoteDocument.sortOrder`) — Terms, General Conditions of Sale, the
   * RSP agreement, and whatever a region adds later. One ordered list where
   * there used to be three hardcoded fields, so adding a document is a row
   * rather than a code change. A FINAL quote's list comes from its
   * `documentsSnapshot` when that parses; everything else renders live. */
  documents: QuotationDocumentSection[];
  showSignature: boolean;
  /** Pass-through of `QuotationDataDoc`'s toggles for `QuotationSheet` to
   * gate the investment summary's per-item/per-option amount columns —
   * `showOptionPrices` implies item totals are visible too (an option's
   * price only makes sense next to the item it's attached to), which is why
   * the sheet treats `showItemPrices || showOptionPrices` as "item amounts
   * visible" rather than reading `showItemPrices` alone. */
  showItemPrices: boolean;
  showOptionPrices: boolean;
  /** Resolved signature images for the two rules at the foot of the quote.
   * A null side prints the empty rule it prints today, so an unsigned or
   * half-signed quote is unchanged from before this feature. */
  signatures: {
    author: QuotationSignature | null;
    client: QuotationSignature | null;
  };
};

/** One resolved signature — one of the two rules `Signatures`
 * (src/components/sheet/sections/signatures.tsx) renders at the foot of the
 * quote. */
export type QuotationSignature = {
  /** Already run through `ImageResolver` — a `/api/files/…` URL in the app,
   * a base64 data URI in the PDF and on the client-facing page, both of
   * which render without this app's session cookie. */
  image: string;
  name: string;
  signedAt: string;
};

export type BuildQuotationDataOpts = {
  resolveImage?: ImageResolver;
};

/** Flattens a line's `attributes` to a single small display line, e.g.
 * "metres: 4 · tables: 2" — the only thing a line's attributes feed now
 * (see `QuotationOptionRow.attributesLine`); the per-option `{{metres}}` /
 * `{{tables}}` substitution they also used to drive went with the `option.*`
 * content blocks that referenced it. `null` when the line carries no
 * attributes at all, so the sheet's "attributes ? <div>…</div> : null"
 * check stays a clean on/off switch, same pattern as `dedupeDescription`. */
function attributesLine(attributes: Record<string, string | number> | null): string | null {
  if (!attributes) return null;
  const entries = Object.entries(attributes);
  if (entries.length === 0) return null;
  return entries.map(([key, value]) => `${key}: ${value}`).join(" · ");
}

/**
 * The option roles whose lengths ADD UP to the length of the table itself.
 *
 * `EL_BUSBAR` and `EL_RAIL` are deliberately out. They are the other two of
 * the five roles in `EL_MODULE_ROLE_LIST` (src/lib/production-forms/
 * table-sections.ts), and a FabricPro-compatible layout adds one of each per
 * module — so they run ALONGSIDE the table for its whole length rather than
 * extending it, and counting them would report a 7.2m table as roughly 21.6m.
 * That is why this set is declared here rather than reusing
 * `EL_MODULE_ROLE_LIST`: that constant answers "is this a module the layout
 * owns", which is a different question with a different answer.
 */
const TABLE_LENGTH_ROLES: ReadonlySet<OptionRole> = new Set<OptionRole>([
  "EL_DRIVE",
  "EL_CONVEYOR",
  "EL_STATIC",
]);

/**
 * How many metres of table an item's own option lines add up to — the value
 * behind `{{tableLengthM}}`.
 *
 * The length is not a property of the product: `Product.specs` records an
 * EasyLoader's WIDTH, but its length is a consequence of how this particular
 * item was configured. An EasyLoader is built from 1.2m modules
 * (`SECTION_UNIT_M`), each sold as an option carrying `Option.unitLengthM`,
 * so the figure is the sum over the item's table-module lines of
 * `unitLengthM * qty`.
 *
 * `0` for an item with no table modules — which the caller turns into `""`,
 * the same "no value" `substituteWithReport` strips a line for. That is
 * correct rather than a defect: a category offering the token has products
 * that CAN carry a layout, and an individual item may simply have none.
 */
function tableLengthM(lines: QuotationLineInput[]): number {
  let metres = 0;
  for (const line of lines) {
    if (line.kind !== "OPTION") continue;
    if (line.role === null || !TABLE_LENGTH_ROLES.has(line.role)) continue;
    if (line.unitLengthM === null) continue;
    metres += line.unitLengthM * line.qty;
  }
  return metres;
}

/**
 * Assembles `QuotationData` from a loaded QUOTE document (`doc`) and the
 * full set of `QuoteDocument` rows visible to its region (`documents` — pass
 * `getQuoteDocumentsForRegion(doc.regionId)`'s result). `opts.resolveImage`
 * behaves exactly like `toSheetData`'s (identity for the in-app preview,
 * `fileImageResolver` for the PDF pipeline — Gotenberg's headless Chromium
 * can't hit an auth-gated `/api/files/...` URL).
 */
export function buildQuotationData(
  doc: QuotationDataDoc,
  documents: QuoteDocumentRow[],
  opts: BuildQuotationDataOpts = {}
): QuotationData {
  const resolveImage = opts.resolveImage ?? identityResolver;
  const sheet: DocSheetData = toSheetData(doc, resolveImage);

  // What this quote froze when it went FINAL, or `null` for a DRAFT and for
  // anything that fails to parse (see `readDocumentsSnapshot`). Read once,
  // up here, because it answers two separate questions below: which document
  // bodies to print, and which items' category copy is already fixed.
  const snapshot = readDocumentsSnapshot(doc.documentsSnapshot);
  const snapshotItemCopy = snapshot?.itemCopyHtml ?? {};

  const sheetItemsById = new Map(sheet.items.map((item) => [item.id, item]));

  // `showOptionPrices` implies item totals are visible too (see
  // `QuotationData.showItemPrices`'s doc comment) — this is the one flag a
  // machine title block's `{{price}}` token cares about.
  const itemPriceVisible = doc.showItemPrices || doc.showOptionPrices;

  // Tokens that cost a line somewhere in this quote's category copy, surfaced
  // by the draft preview so an author learns a sentence vanished instead of
  // discovering it in a signed PDF. Never shown on a FINAL quote.
  //
  // Attributed, not just named: the same token can be missing on two items
  // from two different categories, and the reader's next move is to open one
  // category's editor — so each entry carries the item and the category it
  // came from, and the de-duplication key is the whole (item, category, token)
  // triple rather than the token alone. Two items in one category each losing
  // `{{cutHeightCm}}` are two entries, which the banner groups back together
  // under one category heading; two items in *different* categories losing it
  // must never collapse into one, which is exactly what a token-only key did.
  const strippedTokens: StrippedCopyToken[] = [];

  const machineSections: QuotationMachineSection[] = doc.items.map((item) => {
    const lineSummary = sheetItemsById.get(item.id);
    if (!lineSummary) {
      // Defensive only — sheet.items is derived 1:1 from doc.items by
      // toSheetData, so every id here always has a match.
      throw new Error(`buildQuotationData: no sheet item for document item ${item.id}`);
    }

    // `Product.specs` is the one source for a machine's cutting figures
    // (this used to parse them out of the code; the code is a label now --
    // see src/lib/validation/product-specs.ts). A figure the product does
    // not carry substitutes as "" and line-strips like any unresolved token.
    const specs = readProductSpecs(item.specs);
    const cutHeightCm = specs.cutHeightCm !== undefined ? String(specs.cutHeightCm) : "";
    const cutWidthCm = specs.cutWidthCm !== undefined ? String(specs.cutWidthCm) : "";
    // Only a cutting machine gets the "<Series> Cutting Machine ..." line: a
    // spreader carries a `cutWidthCm` too (its spread width) and must not be
    // introduced as one. `seriesName` is the prose the sentence opens with
    // and nothing else keys on it.
    const specSentence =
      item.kind === "MACHINE" && item.seriesName ? machineSpecSentence(item.seriesName, specs) : null;
    // Only the figures this product carries — the two width tokens for
    // equipment with a width but no cutting spec. Each missing one becomes
    // `""` in `vars` below, which line-strips exactly as an absent key did.
    const extraSpecs = extraSpecVars(specs);
    // Metres of table this item's own option lines add up to — see
    // `tableLengthM`. Computed once here, formatted into `vars` below.
    const itemTableLengthM = tableLengthM(item.lines);

    // The placeholder vars the category's copy resolves against — this
    // product's own figures, so one text authored per category reads
    // correctly under every product in it.
    //
    // Typed as an exhaustive record over `CategoryTokenName`, which is what
    // ties this object to src/lib/quote-variables.ts: the registry is what
    // the catalog editor offers and the save validator accepts, so a token
    // declared there with no value here would be offered, saved, and then
    // silently delete its own line on every quote — the exact shape of the
    // `{{name}}` defect. Adding a name to `CATEGORY_TOKEN_NAMES` now fails to
    // compile until a value appears below.
    //
    // Which means every key is unconditional. A figure this product does not
    // carry is `""`, not an omitted key: `substituteWithReport` treats the
    // two identically (`value === undefined || value === ""` — strip the
    // line, report the token), so the behaviour is the one a conditional
    // spread gave, without the hole in the type.
    const vars: Record<CategoryTokenName, string | typeof OMIT> = {
      model: item.code,
      // The item's own name, the same string `sectionTitle` uses — so copy
      // that opens "The {{name}} ..." reads as the heading does.
      name: item.name,
      cutHeightCm,
      cutWidthCm,
      specSentence: specSentence ?? "",
      // `{{tableWidthMm}}` / `{{paperWidthMm}}` for the equipment that has
      // a width but no cutting spec (EasyLoader, Punchline).
      tableWidthMm: extraSpecs.tableWidthMm ?? "",
      // The one COMPUTED token: summed from this item's own table-module
      // option lines rather than read off its product (see `tableLengthM`).
      // A zero sum is `""`, so an item with no layout configured loses the
      // line and reports the token, exactly as a missing spec figure does.
      tableLengthM: itemTableLengthM > 0 ? formatMetres(itemTableLengthM) : "",
      paperWidthMm: extraSpecs.paperWidthMm ?? "",
      // The item's own TOTAL — qty * unit price plus every attached option,
      // exactly the figure `lineSummary.total` already carries from the
      // pricing engine (`totals.itemTotals`, see getDocumentForBuilder) —
      // not the bare unit price, and always currency-formatted via
      // formatMoney, never a raw decimal string. Gated by the same toggle as
      // everywhere else an item amount shows; when hidden, `OMIT` makes
      // substituteWithReport strip the whole "**Price: {{price}}**" line out
      // of the category's copy entirely (never a blank "Price: ____") and —
      // unlike a genuinely missing figure — never report it as stripped: a
      // hidden price is deliberate, not a gap.
      price: itemPriceVisible ? formatMoney(lineSummary.total, sheet.totals.currency) : OMIT,
      // The machine on its own, with no options folded in (see
      // `ItemBreakdown.basePrice` in src/lib/sheet-data.ts) — owner: "we
      // have included options, but we don't have the base model." Gated by
      // the same toggle as `{{price}}` above; `{{price}}` itself keeps
      // meaning the combined subtotal so catalogue templates that already
      // reference it keep working unchanged.
      basePrice: itemPriceVisible ? formatMoney(lineSummary.breakdown.basePrice, sheet.totals.currency) : OMIT,
    };

    const categoryCopy = item.seriesQuoteDescription ?? "";
    // What this item's copy froze as, when the quote went FINAL with a
    // snapshot that has an entry for it. Per item, not per quote: an item
    // added to a snapshot written before it existed — or one whose category
    // had no copy then — has no entry here and renders live, which is a
    // sentence more than the alternative of printing nothing for it.
    const frozenCopy = snapshotItemCopy[item.id];
    const copyReport = categoryCopy ? substituteWithReport(categoryCopy, vars) : { text: "", stripped: [] };
    // A frozen body was substituted once, on the day it was signed; nothing
    // was stripped from it now, so nothing is reported now either (the draft
    // banner these feed is a DRAFT-only affordance regardless).
    for (const token of frozenCopy !== undefined ? [] : copyReport.stripped) {
      const alreadyReported = strippedTokens.some(
        (reported) =>
          reported.token === token && reported.itemName === item.name && reported.seriesId === item.seriesId
      );
      if (alreadyReported) continue;
      strippedTokens.push({
        token,
        itemName: item.name,
        seriesName: item.seriesName,
        seriesId: item.seriesId,
      });
    }
    // Re-sanitized on the way out even though `finalizeDocument` wrote it
    // already rendered: `documentsSnapshot` is an opaque `Json?` column, and
    // every read of stored markup in this app goes through the same seam.
    const titleBlockHtml =
      frozenCopy !== undefined
        ? frozenCopy
          ? renderStoredRichText(frozenCopy)
          : null
        : copyReport.text
          ? renderStoredRichText(copyReport.text)
          : null;

    // Structural section price — the same figure substituted into `vars.price`
    // above, exposed separately so the sheet prints it under EVERY section
    // heading rather than depending on the category copy happening to
    // reference `{{price}}` itself.
    const sectionPrice = itemPriceVisible ? formatMoney(lineSummary.total, sheet.totals.currency) : null;

    // Does the copy print a price of its own, so the sheet must not print the
    // structural one under the heading as well (`equipment-detail.tsx`:
    // `sectionPrice && !hasInlinePrice`)? Two questions, and a raw
    // `categoryCopy.includes("{{price}}")` answered neither:
    //
    //  - Is there a price token at all? `tokensIn` is the registry's own
    //    definition of a token, the same one the editor's palette and the
    //    save validator use, so `{{ price }}` — which every one of those
    //    accepts, and which substitutes perfectly well — counts here too. A
    //    substring test missed it and printed the price twice.
    //  - Did it survive? A price line carrying a SECOND, missing token
    //    (`Price: {{price}} ({{cutHeightCm}} high)`) is stripped whole, and
    //    the raw copy cannot tell: the section then showed no price at all.
    //    Substituting a stand-in for `{{price}}` and looking for it in the
    //    stripped output answers that directly. The stand-in is never `OMIT`,
    //    so a price hidden by the display toggle still counts as inline —
    //    that line is withheld on purpose and `sectionPrice` is null beside
    //    it, so neither price prints either way.
    //
    // Both questions are asked of the AUTHORED copy, so a literal "{{price}}"
    // arriving inside some other token's substituted value can still never
    // fool it.
    const hasInlinePrice =
      tokensIn(categoryCopy).includes("price") &&
      substituteWithReport(categoryCopy, { ...vars, price: INLINE_PRICE_PROBE }).text.includes(
        INLINE_PRICE_PROBE
      );

    // A category has no title field of its own, so the heading is always the
    // item's own name. The old rule — trust a content block's title when it
    // was dynamic, ignore it when static — existed because block titles
    // sometimes carried the wrong product's name; nothing can carry a wrong
    // name any more.
    const sectionTitle = item.name;

    // Unified options table (owner: "table with small icons") — one row per
    // selected OPTION line, replacing the old prose-paragraphs (block
    // matched) vs. bold-bullets (unmatched) split that rendered
    // inconsistently. Every row describes itself the same way now: from the
    // description the line snapshotted off `Option.shortDescription`, so
    // there is only one path and no option can render through a different
    // one than its neighbour.
    const optionRows: QuotationOptionRow[] = [];
    const docLinesById = new Map(lineSummary.lines.map((docLine) => [docLine.id, docLine]));
    for (const line of item.lines) {
      if (line.kind !== "OPTION") continue;
      const docLine = docLinesById.get(line.id);
      const name = docLine?.name ?? line.name;

      const rawDescription = dedupeDescription(name, docLine?.description ?? line.description);
      const descriptionHtml = rawDescription ? renderStoredRichText(rawDescription) : null;

      optionRows.push({
        id: line.id,
        icon: line.imageUrl ? (resolveImage(line.imageUrl) ?? null) : null,
        code: dedupeOptionCode(line.code, name),
        name,
        descriptionHtml,
        attributesLine: attributesLine(line.attributes),
        qty: docLine?.qty ?? line.qty,
        price: doc.showOptionPrices ? formatMoney(docLine?.lineTotal ?? "0", sheet.totals.currency) : null,
      });
    }

    // The same two rules the Investment Summary's own base row follows (see
    // `ItemBreakdownRows`), applied here too because this table shows the same
    // machine at the same price: a base row with no price of its own prints no
    // money, and one whose price is wholly carried by the option rows below it
    // does not print at all. Letting the two tables disagree would put "$0"
    // next to the EasyLoader on one page and nothing on the next.
    const { assembledFromOptions, basePriceUnquoted } = lineSummary.breakdown;
    const baseRow: QuotationBaseRow | null = assembledFromOptions
      ? null
      : {
          code: dedupeOptionCode(lineSummary.code, lineSummary.name),
          name: lineSummary.name,
          qty: lineSummary.breakdown.qty,
          price:
            doc.showOptionPrices && !basePriceUnquoted
              ? formatMoney(lineSummary.breakdown.basePrice, sheet.totals.currency)
              : null,
        };

    return {
      itemId: item.id,
      sectionTitle,
      titleBlockHtml,
      specSentence,
      sectionPrice,
      hasInlinePrice,
      optionRows,
      baseRow,
      lineSummary,
    };
  });

  // The four standard-terms figures a legal document quotes back at the
  // customer: this quote's own where it sets one, its region's otherwise.
  // They were string literals in this file until now — "14 weeks" was
  // promised to every customer in every region whatever the salesperson had
  // agreed, which for delivery and warranty is a commitment nobody made.
  const terms = resolveQuoteTerms(
    {
      deliveryWeeks: doc.deliveryWeeks,
      installationDays: doc.installationDays,
      trainingDays: doc.trainingDays,
      warrantyMonths: doc.warrantyMonths,
    },
    doc.region
  );

  // The document scope's vars, typed exhaustively over `DocumentTokenName`
  // for exactly the reason the category scope's `vars` above is typed over
  // `CategoryTokenName`: the registry (src/lib/quote-variables.ts) is what
  // the document editor's palette offers and its save validator accepts, so
  // a token declared there with no value here would be offered, saved, and
  // then silently delete its own line on every quote. Adding a name to
  // `DOCUMENT_TOKEN_NAMES` now fails to compile until a value appears here.
  //
  // The last three come from the `sheet` object `toSheetData` already
  // returned rather than being re-derived — one date format, one number, one
  // client name on this page.
  const documentVars: Record<DocumentTokenName, string | typeof OMIT> = {
    deliveryWeeks: String(terms.deliveryWeeks),
    installationDays: String(terms.installationDays),
    trainingDays: String(terms.trainingDays),
    warrantyMonths: String(terms.warrantyMonths),
    bankDetails: formatBankDetails(sheet.entity.bankDetails),
    validityDate: sheet.validityDate ?? "",
    // `OMIT`, not `""`, for a quote that has no number yet — the one document
    // token deliberately withheld rather than reported. A DRAFT has no number
    // until `finalizeDocument` allocates one, so a Terms clause referencing
    // `{{quoteNumber}}` strips on EVERY unnumbered draft, and there is nothing
    // its author can do about it: the number is not a field anyone types.
    // Reporting it would raise the banner on every such draft, which is how a
    // reader learns to ignore the banner on the drafts where it names a
    // genuinely missing figure. The line still goes (never a blank on a
    // customer-facing quote) and the FINAL, which always has a number,
    // substitutes it normally.
    //
    // `validityDate` and `clientName` below are NOT withheld: both are
    // actionable — attach a client, set the validity — and both are worth
    // knowing about before a quote goes out.
    quoteNumber: sheet.number ?? OMIT,
    clientName: sheet.client?.companyName ?? "",
  };

  // Selection, in this order: resolve each key to the row this region should
  // print → drop the documents nobody opted into → drop the ones this quote
  // unticked → order by the print order an admin set.
  //
  // `includedByDefault: false` is a document a quote must ask for, and the
  // only per-quote channel that exists today is exclusion (`DocumentExclusion`
  // stores what was unticked, never what was ticked) — so such a document is
  // dropped here unconditionally. Every seeded document is `true`; the
  // builder panel would need an inclusion list of its own before an optional
  // one could be turned on, which is not something this renderer can invent.
  const excluded = new Set(doc.excludedDocumentKeys);
  // Collected as the bodies are substituted, so a clause that vanished from
  // the preview says so. `substituteWithReport` rather than
  // `substitutePlaceholders`: the report was being discarded here, which left
  // the D6 banner blind to the whole document scope — a Terms line carrying
  // `{{clientName}}` disappeared from a draft with no client attached and
  // nothing anywhere explained it.
  const strippedDocumentTokens: StrippedDocumentToken[] = [];
  const liveDocuments: QuotationDocumentSection[] = Array.from(
    resolveQuoteDocuments(documents, doc.regionId).values()
  )
    .filter((row) => row.includedByDefault && !excluded.has(row.key))
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((row) => {
      const report = substituteWithReport(row.body, documentVars);
      // `report.stripped` is already distinct within one body, and each body
      // is visited once, so no de-duplication is needed across documents —
      // the same token missing in two documents is two things to fix.
      for (const token of report.stripped) {
        strippedDocumentTokens.push({ token, documentKey: row.key, documentTitle: row.title });
      }
      return {
        key: row.key,
        title: row.title,
        bodyHtml: renderStoredRichText(report.text),
      };
    });

  // A quote that froze its documents prints what it froze. Re-sanitized on
  // the way out for the same reason an item's frozen copy is — the column is
  // opaque `Json?`, and a snapshot that fails to parse at all has already
  // fallen back to `liveDocuments` above rather than throwing here.
  const printedDocuments: QuotationDocumentSection[] = snapshot
    ? snapshot.documents.map((frozen) => ({
        key: frozen.key,
        title: frozen.title,
        bodyHtml: renderStoredRichText(frozen.bodyHtml),
      }))
    : liveDocuments;

  const notesHtml = doc.notes ? renderStoredRichText(doc.notes) : null;

  // One rule is `AUTHOR` (Pathfinder), the other `CLIENT` (Purchaser) — see
  // `Signatures` in src/components/sheet/sections/signatures.tsx, which
  // renders each side's empty rule unchanged when this resolves to `null`.
  const signatureFor = (role: "AUTHOR" | "CLIENT"): QuotationSignature | null => {
    const row = doc.signatures.find((s) => s.role === role);
    if (!row) return null;
    // An unresolvable image still prints the empty rule rather than a
    // broken image icon in the middle of a customer-facing document — for a
    // logo that would be harmless, but on a SIGNED quote it makes the
    // printed document look exactly like one nobody ever signed. The
    // fallback stays (a broken-image icon or an "(unavailable)" string
    // would be worse on a customer-facing quote), but it must not do so
    // silently, hence the warning below.
    const image = resolveImage(row.imageUrl);
    if (!image) {
      // `QuotationDataDoc` carries no document id — this pure module's
      // input never does (see `ToSheetDataDoc`'s header comment) — so
      // `doc.number` is the closest identifier available here; it is
      // `null` for a still-unissued draft, which "(draft)" still
      // distinguishes from a real quote number in the log.
      console.warn(`[quotation] signature image unresolvable for document ${doc.number ?? "(draft)"} (${role})`);
      return null;
    }
    // Same date formatter buildQuotationData already uses for
    // issueDate/validityDate (see toSheetData) — no second date format on
    // this page.
    return { image, name: row.signerName, signedAt: formatDateAU(row.signedAt) };
  };

  return {
    isDraft: sheet.isDraft,
    number: sheet.number,
    issueDate: sheet.issueDate,
    validityDate: sheet.validityDate,
    logo: sheet.logo,
    heroImage: sheet.heroImage,
    entity: sheet.entity,
    client: sheet.client,
    delivery: sheet.delivery,
    preparedBy: sheet.preparedBy,
    notesHtml,
    machineSections,
    strippedTokens,
    // Nothing to report about a body that was substituted once, months ago,
    // and is being replayed verbatim — `liveDocuments` above is computed
    // regardless (it is what a snapshot falls back to) but its report
    // describes text this quote is not printing.
    strippedDocumentTokens: snapshot ? [] : strippedDocumentTokens,
    items: sheet.items.map((item) => ({
      ...item,
      descriptionHtml: item.description ? renderStoredRichText(item.description) : null,
    })),
    extraLines: sheet.extraLines,
    totals: sheet.totals,
    documents: printedDocuments,
    showSignature: sheet.showSignature,
    showItemPrices: doc.showItemPrices,
    showOptionPrices: doc.showOptionPrices,
    signatures: { author: signatureFor("AUTHOR"), client: signatureFor("CLIENT") },
  };
}

// Re-exported so callers building a `QuotationDataDoc` from scratch (tests,
// or a future mapper) can reference the same input types this module
// consumes without reaching back into sheet-data.ts themselves.
export type { ToSheetCompanyInput, ToSheetContactInput };
