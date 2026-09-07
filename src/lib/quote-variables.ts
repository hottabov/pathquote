// The single source of truth for quote template variables: which `{{token}}`
// exists, where its value comes from, and who may use it. Three consumers
// read this one list — the catalog editor (to build its palette and reject an
// out-of-scope token before saving), buildQuotationData (to substitute), and
// the draft preview (to explain a stripped line) — so a token can never be
// offered in the editor without the renderer knowing how to fill it.
//
// Pure by the same rule as machine-specs.ts and sheet-data.ts: no `@/lib/db`
// and no `next/*` imports, so `vitest run` needs no DATABASE_URL.

/** Matches `substitutePlaceholders`'s own pattern in quotation-data.ts —
 * both must accept exactly the same token syntax, including inner spaces. */
const TOKEN_PATTERN = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

export type QuoteToken = {
  token: string;
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
};

/** Available in every category regardless of what its products carry. */
const UNIVERSAL_TOKENS: QuoteToken[] = [
  { token: "model", source: "The product code, e.g. M-5180" },
  { token: "name", source: "The product name as the quote lists it" },
  { token: "price", source: "The item total, options included. Hidden when quote prices are off." },
  { token: "basePrice", source: "The product alone, without options. Hidden when quote prices are off." },
];

/** Available only when the category's products carry the underlying figure. */
const SPEC_TOKENS: Array<QuoteToken & { requires: keyof CategorySpecPresence }> = [
  { token: "cutHeightCm", source: "Compressed lay height in cm, from the product's specs", requires: "cutHeightCm" },
  { token: "cutWidthCm", source: "Cutting or spreading width in cm, from the product's specs", requires: "cutWidthCm" },
  { token: "tableWidthMm", source: "Table width in mm, from the product's specs", requires: "tableWidthMm" },
  { token: "paperWidthMm", source: "Paper width in mm, from the product's specs", requires: "paperWidthMm" },
  {
    token: "specSentence",
    source: "A generated sentence naming the machine and its cutting figures",
    requires: "hasMachine",
  },
];

/** Every token any category could ever offer. Used for the duplicate check
 * and by callers that need the full vocabulary rather than one category's. */
export const CATEGORY_TOKENS: QuoteToken[] = [
  ...UNIVERSAL_TOKENS,
  ...SPEC_TOKENS.map(({ token, source }) => ({ token, source })),
];

/** The tokens this specific category may use, in palette order. A category
 * whose products carry no cut height is never offered `{{cutHeightCm}}` — the
 * reason a spreading table cannot reference one is that the token is not on
 * offer, not that an author remembered not to type it. */
export function categoryTokensFor(presence: CategorySpecPresence): QuoteToken[] {
  return [
    ...UNIVERSAL_TOKENS,
    ...SPEC_TOKENS.filter((t) => presence[t.requires]).map(({ token, source }) => ({ token, source })),
  ];
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
  const names = new Set(allowed.map((t) => t.token));
  return tokensIn(body).filter((token) => !names.has(token));
}
