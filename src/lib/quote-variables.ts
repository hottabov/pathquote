// The single source of truth for quote template variables: which `{{token}}`
// exists, where its value comes from, and who may use it. Three consumers
// read this one list — the catalog editor (to build its palette and reject an
// out-of-scope token before saving), buildQuotationData (to substitute), and
// the draft preview (to explain a stripped line) — so a token can never be
// offered in the editor without the renderer knowing how to fill it.
//
// Pure by the same rule as machine-specs.ts and sheet-data.ts: no `@/lib/db`
// and no `next/*` imports, so `vitest run` needs no DATABASE_URL.

import { readProductSpecs } from "./validation/product-specs";

/** Matches `substitutePlaceholders`'s own pattern in quotation-data.ts —
 * both must accept exactly the same token syntax, including inner spaces. */
const TOKEN_PATTERN = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/**
 * Every token a category may offer, in palette order. This one list is what
 * ties the registry to the renderer: `buildQuotationData` types its `vars`
 * object as `Record<CategoryTokenName, ...>`, so a name added here without a
 * value beside it in quotation-data.ts fails to compile. Before that link
 * existed, `{{name}}` was offered by the palette, accepted by the save
 * validator, and silently deleted its own line on every quote (fixed in
 * 231eef2 — this is the type that stops the next one).
 *
 * `as const` is load-bearing: it is what makes `CategoryTokenName` a union of
 * literals rather than `string`, and so what makes the renderer's record
 * exhaustive.
 */
export const CATEGORY_TOKEN_NAMES = [
  "model",
  "name",
  "price",
  "basePrice",
  "cutHeightCm",
  "cutWidthCm",
  "tableWidthMm",
  "tableLengthM",
  "paperWidthMm",
  "specSentence",
] as const;

export type CategoryTokenName = (typeof CATEGORY_TOKEN_NAMES)[number];

/**
 * Every token a legal document (Terms, General Conditions, RSP) may offer,
 * in palette order. Mirrors CATEGORY_TOKEN_NAMES exactly, for the same
 * reason: buildQuotationData types its document `vars` object as
 * `Record<DocumentTokenName, ...>`, so a name added here without a value
 * beside it there fails to compile.
 *
 * This scope and the category scope are deliberately disjoint — a Terms
 * document has no business referencing `{{cutHeightCm}}`, and a category's
 * copy has no business referencing `{{deliveryWeeks}}`. Keeping two
 * separate lists (rather than one shared list every consumer filters) is
 * what makes `findUnknownTokens` reject each in the other's scope.
 */
export const DOCUMENT_TOKEN_NAMES = [
  "deliveryWeeks",
  "installationDays",
  "trainingDays",
  "warrantyMonths",
  "bankDetails",
  "validityDate",
  "quoteNumber",
  "clientName",
] as const;

export type DocumentTokenName = (typeof DOCUMENT_TOKEN_NAMES)[number];

/** `T` defaults to `string` so a plain `QuoteToken[]` (as `findUnknownTokens`
 * takes) accepts either scope's token list — `QuoteToken<CategoryTokenName>`
 * and `QuoteToken<DocumentTokenName>` are each a subtype of it — while
 * `CATEGORY_TOKENS` and `DOCUMENT_TOKENS` themselves stay typed to their own
 * literal union, which is what gives each scope's `Record<..., ...>` in
 * quotation-data.ts its totality guarantee. */
export type QuoteToken<T extends string = string> = {
  token: T;
  /** Shown beside the token in the editor palette. Says where the value comes
   * from in the user's own terms, not the column name. */
  source: string;
};

/** Which spec figures the products of one category actually carry, and
 * whether any of them is a cutting machine. Built by the caller from the
 * category's products (see `categorySpecPresence` in queries/catalog.ts) —
 * this module stays free of Prisma types. */
export type CategorySpecPresence = {
  cutHeightCm: boolean;
  cutWidthCm: boolean;
  tableWidthMm: boolean;
  paperWidthMm: boolean;
  hasMachine: boolean;
  /** Whether any product in this category is a table someone lays out —
   * `Product.kind === "TABLE"`, which is what an EasyLoader is. Unlike every
   * other flag here it gates a token whose value is not read off
   * `Product.specs` at all but summed from the item's own option lines (see
   * `tableLengthM` in quotation-data.ts), so the question it answers is "can a
   * product of this category carry a layout", not "does a product carry a
   * figure". An individual item with no modules configured still resolves the
   * token to `""` and loses its line, which the draft banner reports. */
  hasTableLayout: boolean;
};

/** What each token means, in the author's terms rather than the column's.
 * Keyed by `CategoryTokenName`, so this table can neither describe a token
 * `CATEGORY_TOKEN_NAMES` does not declare nor leave one it does undescribed. */
const TOKEN_SOURCES: Record<CategoryTokenName, string> = {
  model: "The product code, e.g. M-5180",
  name: "The product name as the quote lists it",
  price: "The item total, options included. Hidden when quote prices are off.",
  basePrice: "The product alone, without options. Hidden when quote prices are off.",
  cutHeightCm: "Compressed lay height in cm, from the product's specs",
  cutWidthCm: "Cutting or spreading width in cm, from the product's specs",
  tableWidthMm: "Table width in mm, from the product's specs",
  tableLengthM: "Total table length, added up from the EasyLoader's 1.2 m modules",
  paperWidthMm: "Paper width in mm, from the product's specs",
  specSentence: "A generated sentence naming the machine and its cutting figures",
};

/** The presence flag a token needs before a category may use it. A token
 * absent from this table is universal: every category carries a value for it
 * regardless of what its products are. */
const TOKEN_REQUIRES: Partial<Record<CategoryTokenName, keyof CategorySpecPresence>> = {
  cutHeightCm: "cutHeightCm",
  cutWidthCm: "cutWidthCm",
  tableWidthMm: "tableWidthMm",
  tableLengthM: "hasTableLayout",
  paperWidthMm: "paperWidthMm",
  specSentence: "hasMachine",
};

/** Every token any category could ever offer, in palette order — derived from
 * `CATEGORY_TOKEN_NAMES` rather than restating it, so the list the renderer is
 * typed against and the list the editor renders are the same list. */
export const CATEGORY_TOKENS: QuoteToken<CategoryTokenName>[] = CATEGORY_TOKEN_NAMES.map((token) => ({
  token,
  source: TOKEN_SOURCES[token],
}));

/** What each document token means, in the author's terms rather than the
 * column's. Keyed by `DocumentTokenName` for the same totality reason
 * `TOKEN_SOURCES` is keyed by `CategoryTokenName`. */
const DOCUMENT_TOKEN_SOURCES: Record<DocumentTokenName, string> = {
  deliveryWeeks: "From this quote, or the region's default when the quote leaves it blank",
  installationDays: "From this quote, or the region's default when the quote leaves it blank",
  trainingDays: "From this quote, or the region's default when the quote leaves it blank",
  warrantyMonths: "From this quote, or the region's default when the quote leaves it blank",
  bankDetails: "The region's bank details",
  validityDate: "The date this quote expires",
  quoteNumber: "This quote's number, e.g. Q-AU-2026-001",
  clientName: "The customer's company name",
};

/** Every token a legal document may offer, in palette order — derived from
 * `DOCUMENT_TOKEN_NAMES` for the same reason `CATEGORY_TOKENS` is derived
 * from `CATEGORY_TOKEN_NAMES`: the list the renderer is typed against and the
 * list the editor's palette shows can never drift apart. */
export const DOCUMENT_TOKENS: QuoteToken<DocumentTokenName>[] = DOCUMENT_TOKEN_NAMES.map((token) => ({
  token,
  source: DOCUMENT_TOKEN_SOURCES[token],
}));

/** The tokens this specific category may use, in palette order. A category
 * whose products carry no cut height is never offered `{{cutHeightCm}}` — the
 * reason a spreading table cannot reference one is that the token is not on
 * offer, not that an author remembered not to type it. */
export function categoryTokensFor(presence: CategorySpecPresence): QuoteToken[] {
  return CATEGORY_TOKENS.filter((t) => {
    const requires = TOKEN_REQUIRES[t.token];
    return requires === undefined || presence[requires];
  });
}

/** Every distinct `{{token}}` in `body`, in first-seen order. */
export function tokensIn(body: string): string[] {
  const found: string[] = [];
  for (const match of body.matchAll(TOKEN_PATTERN)) {
    const token = match[1];
    if (!found.includes(token)) found.push(token);
  }
  return found;
}

/** The tokens in `body` that `allowed` does not cover, in first-seen order.
 * An empty array means the body is safe to save. */
export function findUnknownTokens(body: string, allowed: QuoteToken[]): string[] {
  // `Set<string>`, not `Set<CategoryTokenName>`: the whole job here is to test
  // tokens that may well be none of them (`{{rspYear2Cost}}`, a typo, a
  // hand-pasted token this category cannot fill).
  const names: Set<string> = new Set(allowed.map((t) => t.token));
  return tokensIn(body).filter((token) => !names.has(token));
}

/** Folds a category's products down to "does any product here carry this
 * figure". A token is offered to the editor when at least one product can
 * fill it; a product that cannot simply loses that line, which the draft
 * preview then reports.
 *
 * The single implementation of this fold — `queries/catalog.ts` (building
 * `SeriesDetail.specPresence`) and `actions/catalog/series.ts` (validating a
 * save) both call this rather than each keeping their own copy. `kind` is
 * typed as `string`, not Prisma's `ProductKind`, so this module keeps no
 * Prisma dependency; the caller passes the enum value straight through and it
 * is compared against the literal `"MACHINE"`. */
export function categorySpecPresence(
  products: ReadonlyArray<{ specs: unknown; kind: string }>
): CategorySpecPresence {
  const presence: CategorySpecPresence = {
    cutHeightCm: false,
    cutWidthCm: false,
    tableWidthMm: false,
    paperWidthMm: false,
    hasMachine: false,
    hasTableLayout: false,
  };
  for (const product of products) {
    const specs = readProductSpecs(product.specs);
    if (specs.cutHeightCm !== undefined) presence.cutHeightCm = true;
    if (specs.cutWidthCm !== undefined) presence.cutWidthCm = true;
    if (specs.tableWidthMm !== undefined) presence.tableWidthMm = true;
    if (specs.paperWidthMm !== undefined) presence.paperWidthMm = true;
    if (product.kind === "MACHINE") presence.hasMachine = true;
    // `"TABLE"` is what an EasyLoader is — the only product a layout, and so
    // a `{{tableLengthM}}`, can belong to. Compared against the literal for
    // the same reason `"MACHINE"` is: this module carries no Prisma types.
    if (product.kind === "TABLE") presence.hasTableLayout = true;
  }
  return presence;
}
