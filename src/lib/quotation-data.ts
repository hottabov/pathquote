// Pure assembly for the extended quotation renderer (Phase 6): turns a
// loaded document plus its resolved ContentBlock rows into `QuotationData`,
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
// extra fields (`specs`, `seriesCode`, `serialNumber`) this module needs.
import { formatMoney } from "./format";
import { machineSpecSentence, parseMachineSpecs, extraSpecVars } from "./machine-specs";
import { renderStoredRichText } from "./rich-text";
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
  /** `DocumentLine.attributes` (e.g. `{ metres: 4, tables: 2 }`) — feeds
   * `substitutePlaceholders` for option blocks like `option.MTS` whose body
   * references `{{metres}}`/`{{tables}}`. */
  attributes: Record<string, string | number> | null;
  /** The line's option's `Option.imageUrl` (resolved by `refId` — see
   * `getDocumentForBuilder`'s `optionImageMap`), snapshotted from the
   * catalog at read time rather than frozen on the line itself (an option's
   * icon can be added/changed in the catalog after the line was added, same
   * treatment as an item's own `imageUrl`). `null` for a PRODUCT/CUSTOM line
   * or an OPTION with no catalog image — the unified options table (see
   * `QuotationOptionRow.icon`) simply renders no icon cell content then. */
  imageUrl: string | null;
};

export type QuotationItemInput = ToSheetItemInput & {
  /** `DocumentItem.serialNumber` — used as-is (blank when unset) in the RSP
   * coverage table; never a placeholder-substitution concern. */
  serialNumber: string | null;
  /** The item's product's series code (e.g. "M", "X", "EL") — see
   * `productBlockKey`. `null` for a snapshot item whose product no longer
   * resolves a series. */
  seriesCode: string | null;
  /** `Product.specs` exactly as stored (opaque `Json?`) — validated
   * defensively at runtime, same treatment as `entitySnapshot`/`bankDetails`
   * in sheet-data.ts. */
  specs: unknown;
  lines: QuotationLineInput[];
};

/** Same shape as `ToSheetDataDoc` plus the extra fields needed for the
 * quotation renderer: `regionId` (to resolve region-specific content-block
 * overrides), richer `items` (see `QuotationItemInput`), and the two
 * quotation-first pricing-display toggles (see `setPriceDisplay` in
 * src/lib/actions/documents.ts) that gate per-item/per-option amounts in
 * the investment summary and the `{{price}}` token in a machine title
 * block — the grand total itself is never gated by either flag. */
export type QuotationDataDoc = Omit<ToSheetDataDoc, "items"> & {
  regionId: string;
  items: QuotationItemInput[];
  showItemPrices: boolean;
  showOptionPrices: boolean;
};

/** A `ContentBlock` row exactly as stored — `regionId: null` is the global
 * default, a non-null `regionId` is a region-specific override sharing the
 * same `key` (enforced by the `@@unique([key, regionId])` constraint). */
export type ContentBlockRow = {
  key: string;
  regionId: string | null;
  title: string | null;
  body: string;
  sortOrder: number;
};

// --- resolveBlocks -----------------------------------------------------------

export type ResolvedContentBlock = {
  key: string;
  title: string | null;
  body: string;
  sortOrder: number;
};

/**
 * Reduces every `ContentBlock` row (defaults + every region's overrides —
 * see `getContentBlocksForRegion`) down to one row per key for `regionId`:
 * the region's own override when one exists, otherwise the global default.
 * Rows for a *different* region are ignored entirely (never shadow a
 * default some other region hasn't overridden). Implemented as two passes
 * — defaults first, then overrides for `regionId` — so an override always
 * wins regardless of array order.
 */
export function resolveBlocks(blocks: ContentBlockRow[], regionId: string): Map<string, ResolvedContentBlock> {
  const resolved = new Map<string, ResolvedContentBlock>();

  for (const block of blocks) {
    if (block.regionId !== null) continue;
    resolved.set(block.key, { key: block.key, title: block.title, body: block.body, sortOrder: block.sortOrder });
  }

  for (const block of blocks) {
    if (block.regionId !== regionId) continue;
    resolved.set(block.key, { key: block.key, title: block.title, body: block.body, sortOrder: block.sortOrder });
  }

  return resolved;
}

// --- key mapping ---------------------------------------------------------

/**
 * Candidate `ContentBlock` keys for an option line's code, in priority
 * order: the exact code first (e.g. "ABR-M" -> "option.ABR-M"), then — only
 * when the code contains a "-" — the code with its trailing series suffix
 * stripped (e.g. "ABR-M" -> "option.ABR", "ABR-FP" -> "option.ABR"). A code
 * with no "-" only ever produces the one exact candidate.
 *
 * Fabric Master ("FM180") no longer needs a special-case fallback here: it
 * was catalogued as an M/X-series option with no standalone product to
 * route through `productBlockKey`, but the option itself was retired (not
 * sold anymore, owner decision — see RETIRED_OPTION_CODES in prisma/seed.ts)
 * and dropped from extraction entirely (scripts/extract-catalog.ts), so no
 * document can add a new "FM180" line any more. The `equipment.fabric-master`
 * content block itself is left in place (harmless — content blocks with no
 * matching option are simply never rendered).
 *
 * Callers should try each candidate against the resolved blocks map in
 * order and use the first hit, skipping the option entirely if none
 * resolve.
 */
export function optionBlockKey(code: string): string[] {
  const candidates = [`option.${code}`];
  const lastDash = code.lastIndexOf("-");
  if (lastDash > 0) {
    const stripped = code.slice(0, lastDash);
    const strippedKey = `option.${stripped}`;
    if (!candidates.includes(strippedKey)) candidates.push(strippedKey);
  }
  return candidates;
}

/**
 * The single `ContentBlock` key for a machine/equipment item's product, or
 * `null` when nothing in the content library covers it (item still renders,
 * just without a `titleBlockHtml`). Mapping is by series code:
 *  - "M" / "X" (the cutting-machine series) -> "machine.m-series"
 *  - "EL" (Easy-Loader) -> "equipment.easy-loader"
 *  - "FP" (Fabric Pro) -> "equipment.fabric-pro"
 *  - "P" (Punchline) -> "equipment.punchline"
 *  - "SW" (software) -> "software.pathworks-s" for a "(S)"-suffixed code
 *    (standalone), "software.pathworks-i" for an "(I)"-suffixed code
 *    (integrated), else `null` (an unrecognised SW variant)
 *  - anything else (including "EF", which has no matching content block,
 *    and "L"/"LNS") -> `null`
 */
export function productBlockKey(productCode: string, seriesCode: string | null): string | null {
  switch (seriesCode) {
    case "M":
    case "X":
      return "machine.m-series";
    case "EL":
      return "equipment.easy-loader";
    case "FP":
      return "equipment.fabric-pro";
    case "P":
      return "equipment.punchline";
    case "SW": {
      const upper = productCode.toUpperCase();
      if (upper.includes("(S)")) return "software.pathworks-s";
      if (upper.includes("(I)")) return "software.pathworks-i";
      return null;
    }
    default:
      return null;
  }
}

// --- RSP coverage --------------------------------------------------------

/**
 * Series codes that identify a cutting machine (as opposed to an accessory
 * or software product) for the RSP coverage table — see
 * `buildQuotationData`'s `coverageRows`. Kept separate from
 * `productBlockKey`'s switch because the two questions differ: this is
 * "is this a machine at all" (RSP coverage), that is "which content block
 * describes this specific product".
 */
const MACHINE_SERIES_CODES = new Set(["M", "X", "L", "P", "LNS"]);

/**
 * Display name per series code, for the one piece of prose
 * `machineSpecSentence` needs that the code itself doesn't encode — e.g.
 * "M3390" parses to a height+width but has no way to know it should read
 * "M-Series" rather than "M". Limited to the three series
 * `parseMachineSpecs` actually recognises; any other series code falls back
 * to the raw code itself (moot in practice, since `machineSpecSentence`
 * returns `null` for those series regardless of the name it's given).
 */
const SERIES_DISPLAY_NAMES: Record<string, string> = { M: "M-Series", X: "X-Calibre", L: "L-Series" };

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
 * The strip runs on the raw markdown source, one `\n`-delimited line at a
 * time, *before* `renderStoredRichText` ever sees it — so a whole markdown
 * paragraph/list-item/heading line disappears cleanly instead of leaving a
 * dangling `<p>`/`<li>` with blank content. A resolved multi-line value
 * (e.g. `{{bankDetails}}` — see `formatBankDetails`) substitutes in as-is,
 * embedded `\n`s and all, so each of its own lines becomes its own output
 * line exactly as if they'd been written directly into the block body.
 */
export function substitutePlaceholders(body: string, vars: PlaceholderVars): string {
  const substituted = body.replace(PLACEHOLDER_PATTERN, (_match, token: string) => {
    const value = vars[token];
    if (value === undefined || value === OMIT || value === "") return UNRESOLVED_MARKER;
    return value;
  });

  return substituted
    .split("\n")
    .filter((line) => !line.includes(UNRESOLVED_MARKER))
    .join("\n");
}

// --- buildQuotationData ----------------------------------------------------

/**
 * One row of the machine section's unified options table (owner: "table
 * with small icons — більше контролю ніж списком" — replaces the old
 * two-tier optionBlocksHtml-paragraphs + fallbackOptions-bullets split,
 * which rendered inconsistently — prose for a matched `option.*` block,
 * bold indented lines for an unmatched one — and drifted visually against
 * each other). EVERY selected OPTION line produces exactly one row here,
 * whether or not its code matched a content block, so no selected option is
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
  /** Rendered HTML for the description under the option's name: the matched
   * `option.*` content block's body (placeholders substituted from
   * `line.attributes`) when one exists, else the line's own snapshot
   * `description`, deduped against `name` via `dedupeDescription` the same
   * way an item/extra-line description is — `null` when neither is
   * present. */
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
   * equipment/software/service item, whether or not a content block matched.
   * Only trusts the matched content block's own `title` when it's DYNAMIC —
   * i.e. its raw text contains a `{{` placeholder, like "Pathfinder {{model}}
   * Cutting System" -> "Pathfinder X-5180 Cutting System" — substituting it
   * the same way the body is; a STATIC block title (no placeholder at all,
   * e.g. the generic "Easy-Loader #1" a content-block title used to carry)
   * is never used as the heading, full stop — this is always the item's own
   * `name` instead, same as when there's no block, no title, or a dynamic
   * title's only content was an unresolved placeholder (line-stripped to
   * ""). The item's code renders alongside this separately, as a muted mono
   * suffix — see quotation-sheet.tsx. */
  sectionTitle: string;
  /** Rendered `machine.*`/`equipment.*`/`software.*` block BODY for this
   * item's product, with `{{model}}`/`{{price}}`/`{{cutHeightCm}}`/
   * `{{cutWidthCm}}`/`{{specSentence}}` substituted — `null` when
   * `productBlockKey` found no matching block, in which case the sheet
   * renders `specSentence` (alongside `sectionTitle` and the item's price
   * from `lineSummary`) as a minimal auto-generated section instead — see
   * quotation-sheet.tsx. No longer carries its own top-level heading (that's
   * `sectionTitle`'s job now, rendered once, consistently, outside this
   * HTML) — see the `machine.m-series` seed body, which used to open with
   * its own "## Pathfinder {{model}} Cutting System" line. */
  titleBlockHtml: string | null;
  /** One-line spec summary derived purely from the product code (see
   * `machineSpecSentence` in src/lib/machine-specs.ts) — e.g. "M-Series
   * Cutting Machine, 3cm compressed lay height, 390cm cutting width".
   * `null` when the series/code isn't one `parseMachineSpecs` recognises
   * (most non-cutting-machine products, or a malformed code). */
  specSentence: string | null;
  /** The item's total (incl. options), currency-formatted — same figure as
   * the `{{price}}` token substituted into `titleBlockHtml`, but exposed
   * structurally so the sheet can print it under the section heading for
   * EVERY section, not just one whose matched block happens to reference
   * `{{price}}` inline (owner: several sections — EL-2020, PTW(I), FP-180 —
   * showed no price at all, because their content blocks simply never
   * carried a "Price: {{price}}" line the way machine.m-series's did).
   * `null` when neither price-display toggle is on. See `hasInlinePrice`
   * for when the sheet should print this vs. rely on the block's own inline
   * line instead. */
  sectionPrice: string | null;
  /** `true` when the matched content block's own (pre-substitution) body
   * text already contains a literal `{{price}}` token — i.e. it prints its
   * own price line as part of `titleBlockHtml` (machine.m-series's "**Price:
   * {{price}}**"). The sheet uses this to avoid printing `sectionPrice` a
   * second time for that one section, while every other section (whose
   * block has no such line, or has no block at all) gets it structurally.
   * Always `false` for a blockless section. */
  hasInlinePrice: boolean;
  /** One row per selected OPTION line on this item, in a single unified
   * table (see `QuotationOptionRow`) — replaces the old optionBlocksHtml/
   * fallbackOptions two-tier split; every OPTION line lands here whether or
   * not its code resolved to an `option.*` content block. */
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

export type QuotationBlockSection = {
  key: string;
  title: string | null;
  bodyHtml: string;
};

export type QuotationRspRow = {
  name: string;
  serialNumber: string;
  rspUnitCost: string;
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
  items: QuotationItemRow[];
  extraLines: DocSheetLine[];
  totals: DocSheetTotals;
  /** `terms.*` blocks, sorted by `sortOrder` (matches seed order: delivery,
   * installation, schedule, customer-responsibilities, warranty, rsp,
   * payment). */
  termsSections: QuotationBlockSection[];
  /** `conditions.1`..`conditions.14`, sorted by `sortOrder` — never by key
   * text, which would sort "conditions.10" before "conditions.2". */
  conditionsSections: QuotationBlockSection[];
  rsp: {
    agreementHtml: string | null;
    coverageRows: QuotationRspRow[];
  };
  showSignature: boolean;
  /** Pass-through of `QuotationDataDoc`'s toggles for `QuotationSheet` to
   * gate the investment summary's per-item/per-option amount columns —
   * `showOptionPrices` implies item totals are visible too (an option's
   * price only makes sense next to the item it's attached to), which is why
   * the sheet treats `showItemPrices || showOptionPrices` as "item amounts
   * visible" rather than reading `showItemPrices` alone. */
  showItemPrices: boolean;
  showOptionPrices: boolean;
};

export type BuildQuotationDataOpts = {
  resolveImage?: ImageResolver;
};

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function specString(specs: unknown, key: string): string {
  if (!isPlainObject(specs)) return "";
  const value = specs[key];
  if (value === undefined || value === null) return "";
  return String(value);
}

function attributeVars(attributes: Record<string, string | number> | null): PlaceholderVars {
  if (!attributes) return {};
  const vars: PlaceholderVars = {};
  for (const [key, value] of Object.entries(attributes)) {
    vars[key] = String(value);
  }
  return vars;
}

/** Flattens a line's `attributes` to a single small display line, e.g.
 * "metres: 4 · tables: 2" — same source data as `attributeVars`, just
 * shaped for direct rendering (see `QuotationOptionRow.attributesLine`)
 * instead of `{{token}}` substitution. `null` when the line carries no
 * attributes at all, so the sheet's "attributes ? <div>…</div> : null"
 * check stays a clean on/off switch, same pattern as `dedupeDescription`. */
function attributesLine(attributes: Record<string, string | number> | null): string | null {
  if (!attributes) return null;
  const entries = Object.entries(attributes);
  if (entries.length === 0) return null;
  return entries.map(([key, value]) => `${key}: ${value}`).join(" · ");
}

function collectByPrefix(
  resolved: Map<string, ResolvedContentBlock>,
  prefix: string,
  vars: PlaceholderVars
): QuotationBlockSection[] {
  return Array.from(resolved.values())
    .filter((block) => block.key === prefix || block.key.startsWith(`${prefix}.`))
    .sort((a, b) => a.sortOrder - b.sortOrder)
    .map((block) => ({
      key: block.key,
      title: block.title,
      bodyHtml: renderStoredRichText(substitutePlaceholders(block.body, vars)),
    }));
}

/**
 * Assembles `QuotationData` from a loaded QUOTE document (`doc`) and the
 * full set of `ContentBlock` rows visible to its region (`blocks` — pass
 * `getContentBlocksForRegion(doc.regionId)`'s result). `opts.resolveImage`
 * behaves exactly like `toSheetData`'s (identity for the in-app preview,
 * `fileImageResolver` for the PDF pipeline — Gotenberg's headless Chromium
 * can't hit an auth-gated `/api/files/...` URL).
 */
export function buildQuotationData(
  doc: QuotationDataDoc,
  blocks: ContentBlockRow[],
  opts: BuildQuotationDataOpts = {}
): QuotationData {
  const resolveImage = opts.resolveImage ?? identityResolver;
  const sheet: DocSheetData = toSheetData(doc, resolveImage);
  const resolved = resolveBlocks(blocks, doc.regionId);

  const sheetItemsById = new Map(sheet.items.map((item) => [item.id, item]));

  // `showOptionPrices` implies item totals are visible too (see
  // `QuotationData.showItemPrices`'s doc comment) — this is the one flag a
  // machine title block's `{{price}}` token cares about.
  const itemPriceVisible = doc.showItemPrices || doc.showOptionPrices;

  const machineSections: QuotationMachineSection[] = doc.items.map((item) => {
    const lineSummary = sheetItemsById.get(item.id);
    if (!lineSummary) {
      // Defensive only — sheet.items is derived 1:1 from doc.items by
      // toSheetData, so every id here always has a match.
      throw new Error(`buildQuotationData: no sheet item for document item ${item.id}`);
    }

    // Code parsing is authoritative for a machine's cutting specs (per the
    // owner's domain rule — catalog descriptions can be wrong, e.g. some
    // "220"-width codes are mis-described as "227cm" in the source
    // catalog). Only fall back to the item's stored `specs` JSON when the
    // code doesn't parse against its series' known scheme (an unrecognised
    // series, or a malformed code) — that's the pre-existing behavior this
    // module had before code parsing existed, preserved as-is.
    const parsedSpecs = parseMachineSpecs(item.seriesCode, item.code);
    const cutHeightCm =
      parsedSpecs?.heightCm !== undefined ? String(parsedSpecs.heightCm) : specString(item.specs, "cutHeightCm");
    const cutWidthCm =
      parsedSpecs?.widthCm !== undefined ? String(parsedSpecs.widthCm) : specString(item.specs, "cutWidthCm");
    const seriesDisplayName = item.seriesCode ? (SERIES_DISPLAY_NAMES[item.seriesCode] ?? item.seriesCode) : "";
    const specSentence = machineSpecSentence(seriesDisplayName, item.seriesCode, item.code);

    // Shared placeholder vars for both the block BODY and the block TITLE
    // (see `sectionTitle` below) — one computation, one source of truth, so
    // a title referencing e.g. `{{model}}` (machine.m-series's seed title is
    // now "Pathfinder {{model}} Cutting System", matching its body) resolves
    // identically to the body's own substitution.
    const vars: PlaceholderVars = {
      model: item.code,
      cutHeightCm,
      cutWidthCm,
      ...(specSentence ? { specSentence } : {}),
      // Resolve width placeholders from product code for series that don't
      // encode specs in the code itself (EL, P).
      ...extraSpecVars(item.seriesCode ?? "", item.code),
      // The item's own TOTAL — qty * unit price plus every attached option,
      // exactly the figure `lineSummary.total` already carries from the
      // pricing engine (`totals.itemTotals`, see getDocumentForBuilder) —
      // not the bare unit price, and always currency-formatted via
      // formatMoney, never a raw decimal string. Gated by the same toggle as
      // everywhere else an item amount shows; when hidden, `OMIT` makes
      // substitutePlaceholders strip the whole "**Price: {{price}}**" line
      // out of machine.m-series entirely (never a blank "Price: ____"). No
      // option.* block currently references {{price}} at all — an option's
      // price only ever shows in the investment summary table (gated
      // separately there by `showOptionPrices`), so there's nothing
      // analogous to thread through `attributeVars` below.
      price: itemPriceVisible ? formatMoney(lineSummary.total, sheet.totals.currency) : OMIT,
      // The machine on its own, with no options folded in (see
      // `ItemBreakdown.basePrice` in src/lib/sheet-data.ts) — owner: "we
      // have included options, but we don't have the base model." Gated by
      // the same toggle as `{{price}}` above; `{{price}}` itself keeps
      // meaning the combined subtotal so catalogue templates that already
      // reference it keep working unchanged.
      basePrice: itemPriceVisible ? formatMoney(lineSummary.breakdown.basePrice, sheet.totals.currency) : OMIT,
    };

    const blockKey = productBlockKey(item.code, item.seriesCode);
    const block = blockKey ? resolved.get(blockKey) : undefined;
    const titleBlockHtml = block ? renderStoredRichText(substitutePlaceholders(block.body, vars)) : null;

    // Structural section price (see `QuotationMachineSection.sectionPrice`'s
    // doc comment) — the same figure substituted into `vars.price` above,
    // exposed separately so the sheet can print it under the heading for
    // EVERY section rather than depending on the matched block happening to
    // reference `{{price}}` inline itself. `hasInlinePrice` checks the RAW
    // (pre-substitution) block body text, not `titleBlockHtml`, so it's
    // never fooled by e.g. a literal "{{price}}" appearing inside an
    // unrelated placeholder's substituted value.
    const sectionPrice = itemPriceVisible ? formatMoney(lineSummary.total, sheet.totals.currency) : null;
    const hasInlinePrice = Boolean(block?.body.includes("{{price}}"));

    // The section heading — ALWAYS computed, never conditional on a block
    // matching (root cause of the owner-reported missing headings: only
    // machine.m-series's body happened to carry its own inline "##" heading;
    // equipment.easy-loader/fabric-pro, software.pathworks-*, and
    // equipment.punchline never did, so those sections rendered their body
    // with no heading at all). Only trusts the matched block's own `title`
    // when it's DYNAMIC (raw text contains "{{", e.g. "Pathfinder {{model}}
    // Cutting System") — a STATIC title (no placeholder, e.g. a generic
    // "Easy-Loader #1" a block title used to carry) leaked the wrong name
    // straight onto the sheet, so it's never used at all any more; this is
    // always the item's own `name` instead. A dynamic title still falls back
    // to `name` when substitution leaves it empty (its only content was an
    // unresolved token — see substitutePlaceholders).
    const rawTitle = block?.title ?? null;
    const sectionTitle =
      rawTitle && rawTitle.includes("{{") ? substitutePlaceholders(rawTitle, vars).trim() || item.name : item.name;

    // Unified options table (owner: "table with small icons") — one row per
    // selected OPTION line, whether or not its code resolved to an
    // `option.*` content block, replacing the old prose-paragraphs (matched)
    // vs. bold-bullets (unmatched) split that rendered inconsistently.
    const optionRows: QuotationOptionRow[] = [];
    const docLinesById = new Map(lineSummary.lines.map((docLine) => [docLine.id, docLine]));
    for (const line of item.lines) {
      if (line.kind !== "OPTION") continue;
      const docLine = docLinesById.get(line.id);
      const name = docLine?.name ?? line.name;
      const candidates = line.code ? optionBlockKey(line.code) : [];
      const found = candidates.map((key) => resolved.get(key)).find((b) => b !== undefined);

      const descriptionHtml = found
        ? renderStoredRichText(substitutePlaceholders(found.body, attributeVars(line.attributes)))
        : (() => {
            const raw = dedupeDescription(name, docLine?.description ?? line.description);
            return raw ? renderStoredRichText(raw) : null;
          })();

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

  // `terms.*` blocks reference these standard-terms figures — auto-filled
  // from the original Word template's own defaults (owner: fields must fill
  // themselves in, never leave a "____" blank for something this
  // predictable) rather than left to line-strip as genuinely unresolved.
  // Any of these a future region/override actually wants to vary can simply
  // stop matching the token; there's no per-region source for them today.
  const globalVars: PlaceholderVars = {
    deliveryWeeks: "14",
    installationDays: "2",
    trainingDays: "3",
    warrantyMonths: "12",
    bankDetails: formatBankDetails(sheet.entity.bankDetails),
  };

  const termsSections = collectByPrefix(resolved, "terms", globalVars);
  const conditionsSections = collectByPrefix(resolved, "conditions", globalVars);

  const rspAgreement = resolved.get("rsp.agreement");
  const agreementHtml = rspAgreement
    ? renderStoredRichText(substitutePlaceholders(rspAgreement.body, globalVars))
    : null;

  const coverageRows: QuotationRspRow[] = doc.items
    .filter((item) => MACHINE_SERIES_CODES.has(item.seriesCode ?? "") || Boolean(item.serialNumber))
    .map((item) => ({
      name: item.name,
      serialNumber: item.serialNumber ?? "",
      // Not a markdown line `substitutePlaceholders`'s line-strip rule can
      // apply to — this is a plain table cell (see quotation-sheet.tsx's
      // `.pq-rsp-table`), so an as-yet-unpriced row reads "TBA" rather than
      // the retired "____" blank marker.
      rspUnitCost: "TBA",
    }));

  const notesHtml = doc.notes ? renderStoredRichText(doc.notes) : null;

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
    items: sheet.items.map((item) => ({
      ...item,
      descriptionHtml: item.description ? renderStoredRichText(item.description) : null,
    })),
    extraLines: sheet.extraLines,
    totals: sheet.totals,
    termsSections,
    conditionsSections,
    rsp: { agreementHtml, coverageRows },
    showSignature: sheet.showSignature,
    showItemPrices: doc.showItemPrices,
    showOptionPrices: doc.showOptionPrices,
  };
}

// Re-exported so callers building a `QuotationDataDoc` from scratch (tests,
// or a future mapper) can reference the same input types this module
// consumes without reaching back into sheet-data.ts themselves.
export type { ToSheetCompanyInput, ToSheetContactInput };
