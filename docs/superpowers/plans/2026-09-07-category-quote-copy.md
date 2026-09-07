# Category quote copy in the catalog — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the descriptive text that appears under a product on a quote out of the `ContentBlock` table and onto the catalog category that owns it, with a variable palette that only offers tokens that category's products actually carry.

**Architecture:** A new `Series.quoteDescription` column replaces the `Product.contentBlockKey` → `ContentBlock` lookup. A new pure module, `src/lib/quote-variables.ts`, becomes the single source of truth for which `{{token}}` exists, where its value comes from, and which scope may use it — consumed by the editor (to build the palette and reject unknown tokens), by `buildQuotationData` (to substitute), and by the draft preview (to report what was stripped). Option-level content blocks are deleted; option rows keep the description they already snapshot from `Option.shortDescription`.

**Tech Stack:** Next.js App Router, Prisma/Postgres, TypeScript, Vitest, Tiptap rich text.

**Spec:** `docs/superpowers/specs/2026-09-07-quote-documentation-design.md` — decisions D3, D6, D8, D9 and the "Category scope" variable table.

---

## Scope

**In:** `Series.quoteDescription`, the variable registry and its scope validation, stripped-token reporting and the draft banner, `buildQuotationData` reading category copy, the catalog editor card, migrating the `machine.*` / `equipment.*` / `software.*` block bodies onto categories, and deleting the `option.*` blocks with their `contentBlockKey` columns.

**Out — belongs to Plan 3:** the `QuoteDocument` model, the Documents section, `terms.*` / `conditions.*` / `rsp.*`, term values on Region and Document, the snapshot freeze, and dropping the `ContentBlock` model itself. `ContentBlock` survives this plan holding only its legal rows.

**Prerequisite:** the `/documents` → `/quotes` rename is merged (commits `7bb7a0a`…`fcce6bd`).

## File structure

**Created**

| File | Responsibility |
|---|---|
| `src/lib/quote-variables.ts` | The token registry: every `{{token}}`, its human-readable source, its scope, and `validateTokensInScope`. Pure — no `@/lib/db`, no `next/*`, so Vitest runs it with no `DATABASE_URL`. |
| `tests/quote-variables.test.ts` | Unit tests for the registry and validation. |
| `src/lib/validation/series.ts` | Zod schema for the quote-description form. |
| `src/components/catalog/series-quote-description-card.tsx` | The admin editor card: rich text plus variable palette. |
| `scripts/migrate-content-blocks-to-series.ts` | One-shot data migration. |

**Modified**

| File | Change |
|---|---|
| `prisma/schema.prisma` | `Series.quoteDescription`; later, drop `Product.contentBlockKey` and `Option.contentBlockKey` |
| `src/lib/quotation-data.ts` | Item copy from the category; delete `attributeVars`; drop `contentBlockKey` from the input types |
| `src/lib/queries/documents-builder.ts` | Carry `seriesQuoteDescription` on each item; stop resolving `contentBlockKey` |
| `src/lib/queries/catalog.ts` | Expose `quoteDescription` and the category's available spec tokens |
| `src/lib/actions/catalog/series.ts` (new file in an existing folder) | `updateSeriesQuoteDescription` |
| `src/lib/actions/catalog.ts` | Re-export it from the barrel |
| `src/app/(app)/catalog/[seriesId]/page.tsx` | Render the new card for admins |
| `src/app/(app)/quotes/[documentId]/quotation/page.tsx` | Draft-only stripped-token banner |
| `src/lib/catalog-xlsx/*` | Drop the two `contentBlockKey` columns |
| `tests/quotation-data.test.ts` | Update for the new item shape |

**Not touched:** `Option.shortDescription` (it already carries option copy onto a quote — see the spec's corrections note), `attributesLine`, the `Series` model name (D9), `ContentBlock` itself.

---

### Task 1: Add `Series.quoteDescription`

**Files:**
- Modify: `prisma/schema.prisma` (the `Series` model, around line 234)

- [ ] **Step 1: Add the column**

In `model Series`, after `imageUrl`, add:

```prisma
  /// The category's quote copy: the prose printed under a product's heading
  /// in the Equipment Detail section, authored once per category and shared
  /// by every product in it. HTML, and may contain `{{token}}` placeholders
  /// resolved per product at render time — see src/lib/quote-variables.ts for
  /// the token list and which of them a given category may use. Null or
  /// empty prints nothing at all under the heading, which is the state every
  /// category starts in. Replaces the old Product.contentBlockKey ->
  /// ContentBlock lookup: one text per category rather than a key on all 57
  /// products pointing into a separate table.
  quoteDescription  String?
```

- [ ] **Step 2: Create the migration**

```bash
cd "/Users/vadym/Documents/PF Invoice"
npx prisma migrate dev --name series_quote_description --create-only
```

Expected: a new folder under `prisma/migrations/` containing a `migration.sql`
with a single `ALTER TABLE "Series" ADD COLUMN "quoteDescription" TEXT;`. Read
the file and confirm it contains nothing else — in particular no `DROP`.

- [ ] **Step 3: Apply it and regenerate the client**

```bash
cd "/Users/vadym/Documents/PF Invoice"
npx prisma migrate dev
npx prisma generate
```

Expected: the migration applies and the client regenerates.

- [ ] **Step 4: Verify the column exists**

```bash
cd "/Users/vadym/Documents/PF Invoice"
npx prisma db execute --stdin <<'SQL'
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'Series' AND column_name = 'quoteDescription';
SQL
```

Expected: one row, `text`, `YES`.

- [ ] **Step 5: Commit**

```bash
cd "/Users/vadym/Documents/PF Invoice"
rm -f .git/index.lock .git/HEAD.lock
git add prisma/
git commit -m "feat: add Series.quoteDescription

Category quote copy moves from ContentBlock onto the category itself.
Column only; nothing reads it yet."
```

---

### Task 2: The variable registry

This is the module that makes variables self-documenting. It answers three
questions in one place: what tokens exist, where each one's value comes from,
and which of them a given category may use. The editor builds its palette from
it, the renderer substitutes from it, and the validator rejects against it —
so the three can never drift.

**Files:**
- Create: `src/lib/quote-variables.ts`
- Test: `tests/quote-variables.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/quote-variables.test.ts`:

```ts
// Pure registry — no DB, no next/*, same discipline as machine-specs.test.ts.
import { describe, it, expect } from "vitest";
import {
  CATEGORY_TOKENS,
  categoryTokensFor,
  findUnknownTokens,
  tokensIn,
  type CategorySpecPresence,
} from "../src/lib/quote-variables";

const noSpecs: CategorySpecPresence = {
  cutHeightCm: false,
  cutWidthCm: false,
  tableWidthMm: false,
  paperWidthMm: false,
  hasMachine: false,
};

describe("tokensIn", () => {
  it("finds every placeholder in a body", () => {
    expect(tokensIn("A {{model}} cutting {{cutWidthCm}}cm wide")).toEqual(["model", "cutWidthCm"]);
  });

  it("tolerates inner whitespace the renderer also tolerates", () => {
    expect(tokensIn("{{ model }}")).toEqual(["model"]);
  });

  it("returns each token once, in first-seen order", () => {
    expect(tokensIn("{{model}} and {{model}} and {{price}}")).toEqual(["model", "price"]);
  });

  it("returns an empty array for a body with no placeholders", () => {
    expect(tokensIn("<p>Plain copy.</p>")).toEqual([]);
  });
});

describe("categoryTokensFor", () => {
  it("always offers the tokens every product carries", () => {
    const names = categoryTokensFor(noSpecs).map((t) => t.token);
    expect(names).toEqual(["model", "name", "price", "basePrice"]);
  });

  it("offers cutHeightCm only when some product in the category has one", () => {
    const without = categoryTokensFor(noSpecs).map((t) => t.token);
    expect(without).not.toContain("cutHeightCm");

    const withIt = categoryTokensFor({ ...noSpecs, cutHeightCm: true }).map((t) => t.token);
    expect(withIt).toContain("cutHeightCm");
  });

  it("offers specSentence only for a category containing a cutting machine", () => {
    expect(categoryTokensFor(noSpecs).map((t) => t.token)).not.toContain("specSentence");
    expect(categoryTokensFor({ ...noSpecs, hasMachine: true }).map((t) => t.token)).toContain("specSentence");
  });

  it("gives every offered token a source description for the editor", () => {
    for (const token of categoryTokensFor({ ...noSpecs, cutWidthCm: true })) {
      expect(token.source.length).toBeGreaterThan(0);
    }
  });
});

describe("findUnknownTokens", () => {
  const specs: CategorySpecPresence = { ...noSpecs, cutWidthCm: true };

  it("accepts a body using only in-scope tokens", () => {
    expect(findUnknownTokens("{{model}} at {{cutWidthCm}}cm", categoryTokensFor(specs))).toEqual([]);
  });

  it("rejects a token this category has no data for", () => {
    // The spec's motivating example: a table template cannot ask for cut height.
    expect(findUnknownTokens("{{cutHeightCm}} high", categoryTokensFor(specs))).toEqual(["cutHeightCm"]);
  });

  it("rejects a token that exists nowhere in the app", () => {
    expect(findUnknownTokens("{{rspYear2Cost}}", categoryTokensFor(specs))).toEqual(["rspYear2Cost"]);
  });

  it("reports every unknown token, not just the first", () => {
    expect(findUnknownTokens("{{a}} {{model}} {{b}}", categoryTokensFor(specs))).toEqual(["a", "b"]);
  });
});

describe("CATEGORY_TOKENS", () => {
  it("declares no token twice", () => {
    const names = CATEGORY_TOKENS.map((t) => t.token);
    expect(new Set(names).size).toBe(names.length);
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd "/Users/vadym/Documents/PF Invoice"
npx vitest run tests/quote-variables.test.ts
```

Expected: FAIL — `Cannot find module '../src/lib/quote-variables'`.

- [ ] **Step 3: Write the module**

Create `src/lib/quote-variables.ts`:

```ts
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
```

- [ ] **Step 4: Run the test**

```bash
cd "/Users/vadym/Documents/PF Invoice"
npx vitest run tests/quote-variables.test.ts
```

Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
cd "/Users/vadym/Documents/PF Invoice"
rm -f .git/index.lock .git/HEAD.lock
git add src/lib/quote-variables.ts tests/quote-variables.test.ts
git commit -m "feat: add the quote variable registry

One list of every {{token}}, its source and its scope, so the editor
palette, the renderer and the validator cannot drift apart. A category
is only offered tokens its own products carry a value for."
```

---

### Task 3: Report which tokens were stripped

`substitutePlaceholders` deletes any line holding an unresolved token, and
says nothing. That silence is what the spec's decision D6 fixes: the draft
preview must be able to say which lines went and why. This task adds the
reporting without changing the stripping behaviour.

**Files:**
- Modify: `src/lib/quotation-data.ts:202-213`
- Test: `tests/quotation-data.test.ts`

- [ ] **Step 1: Write the failing test**

Add to `tests/quotation-data.test.ts`, inside the existing
`describe("substitutePlaceholders"...)` block (add `substituteWithReport` to
the file's existing import from `../src/lib/quotation-data`):

```ts
  it("reports the token that caused a line to be stripped", () => {
    const result = substituteWithReport("Kept {{model}}\nGone {{cutHeightCm}}", { model: "M-5180" });
    expect(result.text).toBe("Kept M-5180");
    expect(result.stripped).toEqual(["cutHeightCm"]);
  });

  it("reports nothing when every token resolves", () => {
    const result = substituteWithReport("Kept {{model}}", { model: "M-5180" });
    expect(result.text).toBe("Kept M-5180");
    expect(result.stripped).toEqual([]);
  });

  it("does not report a deliberately withheld token", () => {
    // OMIT means "hidden on purpose right now" (a price with the toggle off),
    // not "we have no data" — surfacing it would cry wolf on every quote
    // that simply hides prices.
    const result = substituteWithReport("Price: {{price}}", { price: OMIT });
    expect(result.text).toBe("");
    expect(result.stripped).toEqual([]);
  });

  it("reports every distinct missing token once", () => {
    const result = substituteWithReport("{{a}}\n{{b}}\n{{a}}", {});
    expect(result.stripped).toEqual(["a", "b"]);
  });

  it("leaves substitutePlaceholders behaving exactly as before", () => {
    expect(substitutePlaceholders("Kept {{model}}\nGone {{x}}", { model: "M" })).toBe("Kept M");
  });
```

- [ ] **Step 2: Run it and watch it fail**

```bash
cd "/Users/vadym/Documents/PF Invoice"
npx vitest run tests/quotation-data.test.ts -t "reports the token that caused"
```

Expected: FAIL — `substituteWithReport is not a function`.

- [ ] **Step 3: Implement**

In `src/lib/quotation-data.ts`, replace the body of `substitutePlaceholders`
(lines 202-213) with a thin wrapper over a new reporting function, keeping the
existing doc comment above `substitutePlaceholders` in place:

```ts
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

  const text = substituted
    .split("\n")
    .filter((line) => !line.includes(UNRESOLVED_MARKER))
    .join("\n");

  return { text, stripped };
}

export function substitutePlaceholders(body: string, vars: PlaceholderVars): string {
  return substituteWithReport(body, vars).text;
}
```

- [ ] **Step 4: Run the whole file**

```bash
cd "/Users/vadym/Documents/PF Invoice"
npx vitest run tests/quotation-data.test.ts
```

Expected: PASS, including every pre-existing test — the stripping behaviour is
unchanged, only observable now.

- [ ] **Step 5: Commit**

```bash
cd "/Users/vadym/Documents/PF Invoice"
rm -f .git/index.lock .git/HEAD.lock
git add src/lib/quotation-data.ts tests/quotation-data.test.ts
git commit -m "feat: report which tokens cost their line

substitutePlaceholders silently deleted any line holding an unresolved
token. It still does, but substituteWithReport now says which token did
it, so the draft preview can tell the author what vanished. A token
withheld with OMIT stays unreported: that is a hidden price, not a gap."
```

---

### Task 4: Render category copy instead of a content block

**Files:**
- Modify: `src/lib/quotation-data.ts` — `QuotationItemInput` (65-87), `QuotationLineInput` (43-63), `buildQuotationData` (514-663)
- Test: `tests/quotation-data.test.ts`, `tests/helpers/fixtures.ts`

- [ ] **Step 1: Write the failing tests**

In `tests/quotation-data.test.ts`, add a new describe block:

```ts
describe("category quote copy", () => {
  it("renders the category's copy under the item heading", () => {
    const doc = quotationDoc({
      items: [
        quotationItem({
          name: "M-5180 Cutting Machine",
          seriesQuoteDescription: "Cuts {{cutHeightCm}}cm at {{cutWidthCm}}cm wide.",
          specs: { cutHeightCm: 5, cutWidthCm: 180 },
        }),
      ],
    });
    const data = buildQuotationData(doc, []);
    expect(data.machineSections[0].titleBlockHtml).toContain("Cuts 5cm at 180cm wide.");
  });

  it("renders nothing when the category has no copy", () => {
    const doc = quotationDoc({ items: [quotationItem({ seriesQuoteDescription: null })] });
    const data = buildQuotationData(doc, []);
    expect(data.machineSections[0].titleBlockHtml).toBeNull();
  });

  it("always titles the section with the item's own name", () => {
    // The old rule trusted a content block's dynamic title; there is no title
    // field on a category any more, so this is now unconditional.
    const doc = quotationDoc({
      items: [quotationItem({ name: "L-220 Cutting Machine", seriesQuoteDescription: "<p>Copy.</p>" })],
    });
    const data = buildQuotationData(doc, []);
    expect(data.machineSections[0].sectionTitle).toBe("L-220 Cutting Machine");
  });

  it("strips a line whose figure this product lacks and reports the token", () => {
    // An L-Series machine carries cutWidthCm but no cutHeightCm.
    const doc = quotationDoc({
      items: [
        quotationItem({
          seriesQuoteDescription: "Width {{cutWidthCm}}cm\nHeight {{cutHeightCm}}cm",
          specs: { cutWidthCm: 220 },
        }),
      ],
    });
    const data = buildQuotationData(doc, []);
    expect(data.machineSections[0].titleBlockHtml).toContain("Width 220cm");
    expect(data.machineSections[0].titleBlockHtml).not.toContain("Height");
    expect(data.strippedTokens).toEqual(["cutHeightCm"]);
  });

  it("still detects an inline price token in the category copy", () => {
    const doc = quotationDoc({
      items: [quotationItem({ seriesQuoteDescription: "Price: {{price}}" })],
      showItemPrices: true,
    });
    const data = buildQuotationData(doc, []);
    expect(data.machineSections[0].hasInlinePrice).toBe(true);
  });
});

describe("option rows", () => {
  it("describes an option from its own snapshot description", () => {
    const doc = quotationDoc({
      items: [
        quotationItem({
          lines: [
            {
              id: "l-1",
              kind: "OPTION",
              name: "Motorised Table System",
              description: "Adds a motorised transfer table.",
              qty: 1,
              attributes: { metres: 4 },
              imageUrl: null,
            },
          ],
        }),
      ],
    });
    const data = buildQuotationData(doc, []);
    const row = data.machineSections[0].optionRows[0];
    expect(row.descriptionHtml).toContain("Adds a motorised transfer table.");
    expect(row.attributesLine).toBe("metres: 4");
  });
});
```

Note: the option-line fixture above omits `contentBlockKey` deliberately — the
field is being removed. Update `quotationItem` and any line fixture in
`tests/helpers/fixtures.ts` to drop `contentBlockKey` and add
`seriesQuoteDescription: null` as the default.

- [ ] **Step 2: Run and watch it fail**

```bash
cd "/Users/vadym/Documents/PF Invoice"
npx vitest run tests/quotation-data.test.ts -t "category quote copy"
```

Expected: FAIL — the fixtures do not carry `seriesQuoteDescription`.

- [ ] **Step 3: Change the input types**

In `src/lib/quotation-data.ts`:

Replace the `contentBlockKey` field on `QuotationItemInput` (lines 81-85) with:

```ts
  /** `Series.quoteDescription` — the copy authored once for this item's
   * category, printed under the item's heading with this product's own
   * figures substituted in. `null` or empty prints nothing, which is what a
   * category nobody has written copy for does. Replaces the old
   * `Product.contentBlockKey` lookup into the ContentBlock table. */
  seriesQuoteDescription: string | null;
```

Delete the `contentBlockKey` field from `QuotationLineInput` (lines 49-54)
entirely. Update the module header comment (lines 12-14) to list
`seriesQuoteDescription` instead of `contentBlockKey`.

- [ ] **Step 4: Change `buildQuotationData`**

Delete the `attributeVars` function (lines 453-460). Keep `attributesLine`.

Replace lines 571-583 (the block lookup, `titleBlockHtml`, `sectionPrice`,
`hasInlinePrice`) with:

```ts
    const categoryCopy = item.seriesQuoteDescription ?? "";
    const copyReport = categoryCopy ? substituteWithReport(categoryCopy, vars) : { text: "", stripped: [] };
    for (const token of copyReport.stripped) {
      if (!strippedTokens.includes(token)) strippedTokens.push(token);
    }
    const titleBlockHtml = copyReport.text ? renderStoredRichText(copyReport.text) : null;

    // Structural section price — the same figure substituted into `vars.price`
    // above, exposed separately so the sheet prints it under EVERY section
    // heading rather than depending on the category copy happening to
    // reference `{{price}}` itself. `hasInlinePrice` checks the RAW
    // (pre-substitution) copy, so it is never fooled by a literal "{{price}}"
    // appearing inside some other token's substituted value.
    const sectionPrice = itemPriceVisible ? formatMoney(lineSummary.total, sheet.totals.currency) : null;
    const hasInlinePrice = categoryCopy.includes("{{price}}");
```

Declare the accumulator just above the `machineSections` mapping (before line
514):

```ts
  // Tokens that cost a line somewhere in this quote's category copy, surfaced
  // by the draft preview so an author learns a sentence vanished instead of
  // discovering it in a signed PDF. Never shown on a FINAL quote.
  const strippedTokens: string[] = [];
```

Replace the `sectionTitle` computation (lines 598-600) with:

```ts
    // A category has no title field of its own, so the heading is always the
    // item's own name. The old rule — trust a content block's title when it
    // was dynamic, ignore it when static — existed because block titles
    // sometimes carried the wrong product's name; nothing can carry a wrong
    // name any more.
    const sectionTitle = item.name;
```

In the option loop, replace lines 612-619 with:

```ts
      const rawDescription = dedupeDescription(name, docLine?.description ?? line.description);
      const descriptionHtml = rawDescription ? renderStoredRichText(rawDescription) : null;
```

Add `strippedTokens` to the returned object (around line 701), and to the
`QuotationData` type:

```ts
  /** Category-copy tokens that had no value on this quote, so their line was
   * removed. The draft preview lists them; the FINAL PDF ignores them. */
  strippedTokens: string[];
```

- [ ] **Step 5: Run the tests**

```bash
cd "/Users/vadym/Documents/PF Invoice"
npx vitest run tests/quotation-data.test.ts
```

Expected: PASS. Pre-existing tests that assert on `contentBlockKey`-driven
titles or `option.*` block descriptions will fail — rewrite each to the new
behaviour rather than deleting it, keeping what it was actually protecting.
Tests asserting `termsSections`, `conditionsSections` or `rsp` are untouched by
this plan and must still pass unchanged.

- [ ] **Step 6: Commit**

```bash
cd "/Users/vadym/Documents/PF Invoice"
rm -f .git/index.lock .git/HEAD.lock
git add src/lib/quotation-data.ts tests/
git commit -m "feat: print category copy under a quoted item

Item copy comes from Series.quoteDescription instead of a per-product
key into ContentBlock, and an option row keeps the description it
already snapshots from the option. Drops the per-option-line variables
({{metres}}, {{tables}}, ...) with the block lookup that used them, and
reports any token that cost a line."
```

---

### Task 5: Carry the category copy through the builder query

**Files:**
- Modify: `src/lib/queries/documents-builder.ts` — the `DocumentForBuilder` item type (~220-354), the option resolution (~520-536), the returned mapping (~607-713)

- [ ] **Step 1: Add the field to the item shape**

The Prisma query at `documents-builder.ts:470-495` already includes
`product: { include: { series: true } }`, so `Series.quoteDescription` arrives
with no query change. On the item type, replace `contentBlockKey` with:

```ts
  /** `Series.quoteDescription` of the item's product's category, read live
   * from the catalog (not snapshotted on the item) so fixing a typo in a
   * category's copy shows on every DRAFT quote at once. A FINAL quote reads
   * its frozen snapshot instead — see Plan 3. */
  seriesQuoteDescription: string | null;
```

In the returned object, replace the `contentBlockKey` line with:

```ts
      seriesQuoteDescription: item.product?.series?.quoteDescription ?? null,
```

- [ ] **Step 2: Stop resolving the option's block key**

In the `db.option.findMany` select (~line 529), remove `contentBlockKey`.
Remove it from the `BuilderLine` type (~84-90) and from wherever
`optionRowMap` writes it onto a line (~408).

- [ ] **Step 3: Typecheck**

```bash
cd "/Users/vadym/Documents/PF Invoice"
npm run typecheck
```

Expected: exit 0. Any error naming `contentBlockKey` is a call site still
reading the removed field — fix it rather than re-adding the field.

- [ ] **Step 4: Run the suite**

```bash
cd "/Users/vadym/Documents/PF Invoice"
npm test
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
cd "/Users/vadym/Documents/PF Invoice"
rm -f .git/index.lock .git/HEAD.lock
git add src/lib/queries/documents-builder.ts
git commit -m "feat: hand the builder a category's quote copy

The series was already joined; this reads its new column and drops the
two contentBlockKey fields nothing resolves any more."
```

---

### Task 6: Expose the category's copy and token scope to the catalog

**Files:**
- Modify: `src/lib/queries/catalog.ts` — `SeriesDetail` (~320-330), `listProductsBySeriesById` (~123-208)

- [ ] **Step 1: Add both fields to `SeriesDetail`**

```ts
  /** `Series.quoteDescription` — see the schema comment. */
  quoteDescription: string | null;
  /** Which spec figures this category's products actually carry, so the
   * editor offers `{{cutHeightCm}}` to a cutting machine and not to a table.
   * Computed from the products, never stored. */
  specPresence: CategorySpecPresence;
```

- [ ] **Step 2: Compute the presence**

Add to `src/lib/queries/catalog.ts`, importing `readProductSpecs` from
`@/lib/validation/product-specs` and the type from `@/lib/quote-variables`:

```ts
/** Folds a category's products down to "does any product here carry this
 * figure". A token is offered to the editor when at least one product can
 * fill it; a product that cannot simply loses that line, which the draft
 * preview then reports. */
function categorySpecPresence(
  products: Array<{ specs: unknown; kind: ProductKind }>
): CategorySpecPresence {
  const presence: CategorySpecPresence = {
    cutHeightCm: false,
    cutWidthCm: false,
    tableWidthMm: false,
    paperWidthMm: false,
    hasMachine: false,
  };
  for (const product of products) {
    const specs = readProductSpecs(product.specs);
    if (specs.cutHeightCm !== undefined) presence.cutHeightCm = true;
    if (specs.cutWidthCm !== undefined) presence.cutWidthCm = true;
    if (specs.tableWidthMm !== undefined) presence.tableWidthMm = true;
    if (specs.paperWidthMm !== undefined) presence.paperWidthMm = true;
    if (product.kind === "MACHINE") presence.hasMachine = true;
  }
  return presence;
}
```

Make sure the `db.product.findMany` in `seriesProductsResult` selects `specs`
and `kind` — add them if the current select omits them — then populate both new
`SeriesDetail` fields from the loaded rows.

- [ ] **Step 3: Typecheck and commit**

```bash
cd "/Users/vadym/Documents/PF Invoice"
npm run typecheck && npm test
rm -f .git/index.lock .git/HEAD.lock
git add src/lib/queries/catalog.ts
git commit -m "feat: expose a category's quote copy and token scope"
```

---

### Task 7: The save action

**Files:**
- Create: `src/lib/validation/series.ts`
- Create: `src/lib/actions/catalog/series.ts`
- Modify: `src/lib/actions/catalog.ts` (the re-export barrel)
- Test: `tests/series-validation.test.ts`

- [ ] **Step 1: Write the failing validation test**

Create `tests/series-validation.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { seriesQuoteDescriptionSchema } from "../src/lib/validation/series";

describe("seriesQuoteDescriptionSchema", () => {
  it("accepts empty, meaning the category prints nothing", () => {
    expect(seriesQuoteDescriptionSchema.parse("")).toBeNull();
    expect(seriesQuoteDescriptionSchema.parse("   ")).toBeNull();
  });

  it("accepts ordinary copy", () => {
    expect(seriesQuoteDescriptionSchema.parse("<p>Copy.</p>")).toBe("<p>Copy.</p>");
  });

  it("rejects a body over 20000 characters", () => {
    expect(() => seriesQuoteDescriptionSchema.parse("x".repeat(20001))).toThrow();
  });
});
```

- [ ] **Step 2: Run and watch it fail**

```bash
cd "/Users/vadym/Documents/PF Invoice"
npx vitest run tests/series-validation.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the schema**

Create `src/lib/validation/series.ts`. Mirror `bodySchema` in
`src/lib/validation/content.ts` for the length limit, but allow empty (a
category with no copy is the normal starting state, unlike a content block,
which must have a body):

```ts
import { z } from "zod";

/** A category's quote copy. Empty is legitimate and stores as `null` so the
 * renderer's `?? ""` and the "prints nothing" path agree. 20000 matches the
 * limit content blocks already use. */
export const seriesQuoteDescriptionSchema = z.preprocess(
  (value) => (typeof value === "string" && value.trim() === "" ? null : value),
  z.union([z.null(), z.string().max(20000, "Quote description must be at most 20000 characters")])
);
```

- [ ] **Step 4: Write the action**

Create `src/lib/actions/catalog/series.ts`, modelled on `updateSeriesImage` in
`src/lib/actions/catalog/images.ts:62-77`:

```ts
"use server";

import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/authz";
import { revalidateCatalog } from "@/lib/revalidate";
import { sanitizeIfHtml } from "@/lib/rich-text";
import { readProductSpecs } from "@/lib/validation/product-specs";
import { seriesQuoteDescriptionSchema } from "@/lib/validation/series";
import { categoryTokensFor, findUnknownTokens, type CategorySpecPresence } from "@/lib/quote-variables";
import { flattenZodError, type ActionResult } from "../_shared";

/** Saves the copy printed under every product of this category on a quote.
 *
 * Rejects a token the category has no data for — the editor only offers
 * in-scope tokens, so reaching here means a hand-typed or pasted one. This is
 * the check that makes "a table template cannot ask for cut height" a
 * property of the system rather than a convention. */
export async function updateSeriesQuoteDescription(
  seriesId: string,
  formData: FormData
): Promise<ActionResult> {
  await requireAdmin();

  const parsed = seriesQuoteDescriptionSchema.safeParse(formData.get("quoteDescription"));
  if (!parsed.success) return { error: flattenZodError(parsed.error) };

  const series = await db.series.findUnique({
    where: { id: seriesId },
    include: { products: { select: { specs: true, kind: true } } },
  });
  if (!series) return { error: "Series not found" };

  const body = parsed.data;
  if (body) {
    const presence: CategorySpecPresence = {
      cutHeightCm: false,
      cutWidthCm: false,
      tableWidthMm: false,
      paperWidthMm: false,
      hasMachine: false,
    };
    for (const product of series.products) {
      const specs = readProductSpecs(product.specs);
      if (specs.cutHeightCm !== undefined) presence.cutHeightCm = true;
      if (specs.cutWidthCm !== undefined) presence.cutWidthCm = true;
      if (specs.tableWidthMm !== undefined) presence.tableWidthMm = true;
      if (specs.paperWidthMm !== undefined) presence.paperWidthMm = true;
      if (product.kind === "MACHINE") presence.hasMachine = true;
    }

    const unknown = findUnknownTokens(body, categoryTokensFor(presence));
    if (unknown.length > 0) {
      return {
        error: `No value exists for ${unknown.map((t) => `{{${t}}}`).join(", ")} in this category. Remove it or pick a variable from the list.`,
      };
    }
  }

  await db.series.update({
    where: { id: seriesId },
    data: { quoteDescription: body === null ? null : sanitizeIfHtml(body) },
  });

  revalidateCatalog(seriesId);
  return {};
}
```

If `categorySpecPresence` from Task 6 can be imported here without pulling
`next/*` into a pure module, use it instead of repeating the loop, and delete
the duplicate. Check before assuming: `src/lib/queries/catalog.ts` may import
server-only modules.

- [ ] **Step 5: Re-export from the barrel**

In `src/lib/actions/catalog.ts`, beside the existing image exports:

```ts
export { updateSeriesQuoteDescription } from "./catalog/series";
```

- [ ] **Step 6: Verify and commit**

```bash
cd "/Users/vadym/Documents/PF Invoice"
npx vitest run tests/series-validation.test.ts && npm run typecheck && npm run lint
rm -f .git/index.lock .git/HEAD.lock
git add src/lib/validation/series.ts src/lib/actions/catalog/series.ts src/lib/actions/catalog.ts tests/series-validation.test.ts
git commit -m "feat: save a category's quote copy, rejecting out-of-scope tokens

A token the category carries no value for fails to save with a message
naming it, rather than silently deleting its line on every quote."
```

---

### Task 8: The catalog editor card

**Files:**
- Create: `src/components/catalog/series-quote-description-card.tsx`
- Modify: `src/app/(app)/catalog/[seriesId]/page.tsx:164-171`

- [ ] **Step 1: Build the card**

A client component following two existing patterns exactly:

- form mechanics from `src/components/content/content-block-form.tsx:49-84` —
  `useTransition` plus a manual `onSubmit`, not `useActionState`, because
  saving here does not navigate and success needs its own toast; errors show
  both inline (`<p role="alert">`) and as `toast.error`
- the rich text editor from `src/components/catalog/product-form.tsx:45-93` —
  `RichTextEditor` from `@/components/ui-kit/rich-text-editor-lazy`, seeded
  through `toEditorHtml`, with `<input type="hidden" name="quoteDescription">`
  carrying the value

Props: `{ seriesId: string; seriesName: string; defaultValue: string | null; tokens: QuoteToken[]; action: (formData: FormData) => Promise<ActionResult> }`.

Wrap it in `SectionCard` titled "Quote description" with a description reading:
"Printed under every product of this category on a quote. Leave empty to print
nothing."

The variable palette: render `tokens` as clickable chips, each showing
`{{token}}` in a monospace font with its `source` beside it. Clicking inserts
the token at the cursor via the editor's `insertContent` handle
(`RichTextEditorHandle`, `rich-text-editor.tsx:143-150`) — the same affordance
`ContentBlockForm` already gives at `content-block-form.tsx:158-178`. The
palette is the documentation: a reader must be able to learn what
`{{cutWidthCm}}` means without leaving the page.

- [ ] **Step 2: Mount it on the series page**

In `src/app/(app)/catalog/[seriesId]/page.tsx`, inside the existing
`{isAdmin ? ( ... ) : null}` block at lines 164-171, render the new card above
`SeriesImageCard`:

```tsx
      {isAdmin ? (
        <>
          <SeriesQuoteDescriptionCard
            seriesId={series.id}
            seriesName={series.name}
            defaultValue={series.quoteDescription}
            tokens={categoryTokensFor(series.specPresence)}
            action={updateSeriesQuoteDescription.bind(null, series.id)}
          />
          <SeriesImageCard
            currentUrl={series.imageUrl}
            fallbackImageUrl={fallbackImageUrl}
            alt={series.name}
            onSave={updateSeriesImage.bind(null, series.id)}
          />
        </>
      ) : null}
```

Copy sits above the image because it is the thing an admin comes here to write;
the image override is set once and forgotten.

- [ ] **Step 3: Verify by hand**

```bash
cd "/Users/vadym/Documents/PF Invoice"
npm run dev
```

As an admin, open `http://localhost:3100/catalog/<M-Series id>` and check:

1. The Quote description card appears above the Series image card. A manager
   account sees neither.
2. The palette lists `model`, `name`, `price`, `basePrice`, `cutHeightCm`,
   `cutWidthCm`, `specSentence` — and **not** `tableWidthMm`.
3. Opening an EasyLoader category shows `tableWidthMm` and **not**
   `cutHeightCm`. This is the spec's motivating case; if it fails, the presence
   computation in Task 6 is wrong.
4. Clicking a chip inserts the token at the cursor.
5. Saving shows a success toast; reloading shows the saved copy.
6. Typing `{{cutHeightCm}}` by hand into an EasyLoader category and saving
   fails with a message naming the token, and nothing is written.

- [ ] **Step 4: Commit**

```bash
cd "/Users/vadym/Documents/PF Invoice"
npm run typecheck && npm run lint && npm test
rm -f .git/index.lock .git/HEAD.lock
git add src/components/catalog/series-quote-description-card.tsx "src/app/(app)/catalog/[seriesId]/page.tsx"
git commit -m "feat: edit a category's quote copy in the catalog

The editor sits next to the prices and specs it describes, and its
variable palette lists only tokens this category can fill — which is
both the scope rule and the documentation for what each token means."
```

---

### Task 9: The draft-only stripped-token banner

**Files:**
- Modify: `src/app/(app)/quotes/[documentId]/quotation/page.tsx`

- [ ] **Step 1: Render the banner**

Above the `<QuotationSheet/>`, when `quotationData.isDraft` and
`quotationData.strippedTokens.length > 0`, render a warning callout listing the
tokens. Match the visual language of the existing draft affordances on this
page. Wording:

> **Some lines were removed.** No value for `{{cutHeightCm}}` in this quote, so
> the lines using it are not printed. Edit the category's quote description in
> the catalog, or ignore this if the omission is intended.

Never render it when `isDraft` is false — a FINAL quote must show exactly what
the customer sees. The PDF route
(`src/app/api/quotes/[documentId]/quotation-pdf/route.ts`) is not touched at
all; the banner lives on the preview page only, outside `QuotationSheet`.

- [ ] **Step 2: Verify by hand**

With the dev server running: put `{{cutHeightCm}}` into the L-Series category
copy (L-Series products carry no cut height), open a draft quote containing an
L-Series machine, and confirm the banner names `cutHeightCm` and the line is
absent from the sheet. Then finalize and confirm the banner is gone.

- [ ] **Step 3: Commit**

```bash
cd "/Users/vadym/Documents/PF Invoice"
npm run typecheck && npm run lint
rm -f .git/index.lock .git/HEAD.lock
git add "src/app/(app)/quotes/[documentId]/quotation/page.tsx"
git commit -m "feat: say which lines a draft quote dropped

A missing figure deletes its whole line, silently. The draft preview now
names the token that did it. FINAL quotes show the customer's view
unchanged."
```

---

### Task 10: Migrate the existing block copy onto categories

**Files:**
- Create: `scripts/migrate-content-blocks-to-series.ts`

- [ ] **Step 1: Write the script**

Model it on the existing one-shot scripts in `scripts/` (see
`scripts/migrate-catalog-v2.ts` for the house style: a `tsx` entry point, a
dry-run by default, explicit logging of every write).

Mapping, taken from the spec:

| Block key | Destination |
|---|---|
| `machine.m-series` | `Series` code `M` **and** code `X` — both get a copy of the same body; X is edited separately afterwards |
| `equipment.easy-loader` | `Series` code `EL` |
| `equipment.fabric-pro` | `Series` code `FP` |

The block bodies to copy are the global defaults (`regionId: null`). Region
overrides of these three keys are discarded — per the spec, category copy is
not region-scoped, and a machine cuts the same in Mexico City and Sydney. Log
each discarded override so the decision is visible rather than silent.

Delete outright, per the spec's migration table:

- `option.*` — all 17
- `equipment.fabric-master`, `equipment.spreading-table`, `software.*` (6) —
  orphans with no matching category in the catalog

Leave `terms.*`, `conditions.*` and `rsp.*` untouched. Plan 3 migrates those.

The script must refuse to overwrite a `Series.quoteDescription` that is already
non-empty, and must print what it would do before doing it.

- [ ] **Step 2: Dry-run it**

```bash
cd "/Users/vadym/Documents/PF Invoice"
npx tsx scripts/migrate-content-blocks-to-series.ts
```

Expected: a report of 3 category writes and 25 block deletions, with nothing
written. Read the report and confirm the M and X bodies are the ones you
expect.

- [ ] **Step 3: Apply**

```bash
cd "/Users/vadym/Documents/PF Invoice"
npx tsx scripts/migrate-content-blocks-to-series.ts --apply
```

- [ ] **Step 4: Verify**

```bash
cd "/Users/vadym/Documents/PF Invoice"
npx prisma db execute --stdin <<'SQL'
SELECT code, (quoteDescription IS NOT NULL) AS has_copy FROM "Series" ORDER BY code;
SELECT key FROM "ContentBlock" ORDER BY key;
SQL
```

Expected: `M`, `X`, `EL`, `FP` have copy; the remaining `ContentBlock` keys are
only `terms.*`, `conditions.*` and `rsp.*`.

- [ ] **Step 5: Update the seed**

`prisma/seed-data/content-blocks.json` still carries every block. Remove the
`machine.*`, `equipment.*`, `software.*` and `option.*` entries and their
`placeholders` entries for the removed per-option tokens, so a fresh
`npm run db:seed` produces the same state this migration just produced. Add the
three category bodies to wherever the catalog seed defines series, or note in
the file why they are seeded empty.

- [ ] **Step 6: Commit**

```bash
cd "/Users/vadym/Documents/PF Invoice"
npm test
rm -f .git/index.lock .git/HEAD.lock
git add scripts/ prisma/seed-data/
git commit -m "chore: migrate category copy out of ContentBlock

Moves the three block bodies a category actually maps to onto the
category, and deletes the option blocks and the orphans no catalog entry
ever pointed at. Terms, conditions and RSP stay put for Plan 3."
```

---

### Task 11: Drop the two `contentBlockKey` columns

Left until last so every reader is gone before the columns are.

**Files:**
- Modify: `prisma/schema.prisma` (`Product`, `Option`)
- Modify: `src/lib/catalog-xlsx/{columns,export,parse,apply-plan,snapshot}.ts`
- Modify: `src/lib/actions/catalog-import.ts`
- Modify: `src/lib/queries/catalog-xlsx.ts`
- Test: `tests/catalog-xlsx-*.test.ts`

- [ ] **Step 1: Confirm nothing reads them**

```bash
cd "/Users/vadym/Documents/PF Invoice"
grep -rn "contentBlockKey" src/ prisma/ scripts/ tests/
```

Every remaining hit should be in the xlsx pipeline, `catalog-import.ts`, the
schema, or the seed data. If `quotation-data.ts` or `documents-builder.ts`
still appear, Tasks 4 and 5 are incomplete — stop and finish them.

- [ ] **Step 2: Remove from the xlsx pipeline**

Remove the two columns from `src/lib/catalog-xlsx/columns.ts` and every file
that reads them. `tests/catalog-xlsx-parse.test.ts` asserts the column list
against the Prisma schema, so it will fail until both sides agree — that is the
test doing its job. Update the fixtures in `tests/helpers/catalog-xlsx.ts` too.

This changes the spreadsheet format admins bulk-edit the catalog with. An
export made before this change carries two columns the importer no longer
knows. Check how `parse.ts` treats an unrecognised column: if it errors,
make it ignore these two by name with a comment saying why, so an in-flight
spreadsheet does not break someone's day.

- [ ] **Step 3: Drop the columns**

Remove `contentBlockKey` from `model Product` and `model Option` in
`prisma/schema.prisma`, then:

```bash
cd "/Users/vadym/Documents/PF Invoice"
npx prisma migrate dev --name drop_content_block_keys --create-only
```

Read the generated SQL and confirm it drops exactly those two columns and
nothing else, then:

```bash
npx prisma migrate dev && npx prisma generate
```

- [ ] **Step 4: Full verification**

```bash
cd "/Users/vadym/Documents/PF Invoice"
npm run typecheck && npm run lint && npm test
```

Expected: all green.

- [ ] **Step 5: Commit**

```bash
cd "/Users/vadym/Documents/PF Invoice"
rm -f .git/index.lock .git/HEAD.lock
git add -A
git commit -m "refactor: drop Product.contentBlockKey and Option.contentBlockKey

Nothing resolves either any more: category copy lives on the category
and option copy on the option. Removes both from the catalog spreadsheet
format as well."
```

---

### Task 12: Write the five missing category texts

Five categories have never had copy and print nothing under their heading
today. This is an existing gap, not a regression, but it is the visible payoff
of the whole plan.

**Files:** none in the repo — this is content, entered through the UI built in
Task 8.

- [ ] **Step 1: Read the sources**

Existing quote for tone and structure:
`RAW/AAAM Series Australian Sale Template02 (1).docx`

Product facts, from the Pathfinder Brain at
`/Users/vadym/Library/CloudStorage/OneDrive-PathfinderAustralia/Pathfinder Brain`:

| Category | Brain file |
|---|---|
| L-Series | `02 Products/L-Series.md` |
| Leather Nesting System | `02 Products/Leather Nesting System.md` |
| EasyFeeder | `02 Products/EasyLoader & EasyFeeder.md` |
| Heavy Duty Roll Feeder | `02 Products/Roll Feeding.md` |
| Service | `02 Products/Software Overview.md`, `02 Products/PathWorks.md` |

- [ ] **Step 2: Draft each one**

Match the existing `machine.m-series` copy for length and register — it is the
one an owner has already approved. Use only tokens the category's palette
offers: L-Series carries `cutWidthCm` but no `cutHeightCm`, so its copy must
not mention compressed lay height as a variable.

- [ ] **Step 3: Enter and check each**

Paste each into its category's Quote description card, then open a draft quote
containing a product from that category and confirm the copy reads correctly
with real figures substituted and no banner.

- [ ] **Step 4: No commit**

This is database content, not code. Nothing to commit.

---

## Self-review notes

**Spec coverage.** D3 (Task 1, 4, 5, 6, 7, 8), D6 (Tasks 2, 3, 7, 9), D8
(Tasks 4, 10, 11), the category-scope variable table (Task 2), and the missing
category copy called out in the spec's migration section (Task 12).

**Deliberately deferred to Plan 3:** the `QuoteDocument` model, the Documents
section, term values, the snapshot freeze, and dropping `ContentBlock`.
`buildQuotationData` still returns `termsSections`, `conditionsSections` and
`rsp` throughout this plan, and the sheet still renders them — untouched.

**Type consistency check.** `CategorySpecPresence` is defined once in
`src/lib/quote-variables.ts` and imported by `queries/catalog.ts` (Task 6) and
`actions/catalog/series.ts` (Task 7). `substituteWithReport` returns
`{ text, stripped }` in Task 3 and is destructured as such in Task 4.
`seriesQuoteDescription` is the field name in `QuotationItemInput` (Task 4),
`DocumentForBuilder` (Task 5) and the fixtures — not `quoteDescription`, which
is the *column* name on `Series` and the form field name.

**Known risk.** Task 11 changes the catalog spreadsheet format. Step 2 calls
out the backward-compatibility question explicitly rather than leaving the
implementer to discover it.
