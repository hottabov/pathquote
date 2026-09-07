# Quote documents — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Turn the legal text a customer signs — Terms, General Conditions of Sale, Remote Support Program — into whole documents an admin edits in one piece, scoped per region, chosen per quote, and frozen into a quote when it is finalised.

**Architecture:** A new `QuoteDocument` model replaces the `terms.*` / `conditions.*` / `rsp.*` rows in `ContentBlock`, holding each document as one rich-text body rather than 7 or 14 fragments. Region variants are full copies resolved by the same two-pass rule the content blocks already used. The four standard-terms figures move out of hardcoded string literals onto `Region`, overridable per quote. `ContentBlock` is deleted at the end, along with the `Product`/`Option` `contentBlockKey` columns that Plan 2 left behind.

**Tech Stack:** Next.js App Router, Prisma/Postgres, TypeScript, Vitest, Tiptap rich text.

**Spec:** `docs/superpowers/specs/2026-09-07-quote-documentation-design.md` — decisions D1, D2, D4, D5, D6, D7, D10, D11, D12.

---

## Environment constraint

The development database is on Vadym's machine at `localhost:55432`. An agent sandbox cannot reach it.

**Agent-runnable:** file edits, `npm run typecheck`, `npx tsc -p tests --noEmit`, `npm run lint`, `npm test` (pure unit tests, no `DATABASE_URL`), `npx prisma generate`.

**Vadym runs, marked [LOCAL]:** `npm run db:migrate`, `npm run db:seed`, `npx prisma db execute`, `npx tsx scripts/...`, and every browser check.

Migrations are **hand-written** into `prisma/migrations/<name>/migration.sql`. Follow the repo's real convention, which is sequential `z<N>_<name>` folders — run `ls prisma/migrations | sort -V | tail -3` and take the next number. Do not use `prisma migrate dev`.

## Prerequisites

Plan 2 is merged. Two of its steps must have been **applied to the database** before this plan's destructive tasks (11 and 12) run:

- `npm run db:migrate` for `z34_series_quote_description`
- `npx tsx scripts/migrate-content-blocks-to-series.ts --apply`

An agent cannot verify either. Task 12 says so again at the point it matters.

## Scope

**In:** `QuoteDocument`, `DocumentExclusion`, term values on `Region` and `Document`, `documentsSnapshot`, the Documents section, the builder panel, the render pipeline, the migration off `ContentBlock`, and deleting `ContentBlock` and both `contentBlockKey` columns.

**Out:** RSP pricing — per-region rates, quantity discounts, coverage across all cutting machines and FabricPro, and the coverage table itself (D10 removes it here; it returns with that work). Tracked in `docs/plans/meeting-john-wayne-feature-backlog.md:140-148`.

## File structure

**Created**

| File | Responsibility |
|---|---|
| `src/lib/quote-terms.ts` | Pure: resolve the four term values from quote-then-region, and build the document-scope `vars`. |
| `src/lib/queries/quote-documents.ts` | Reads: list for the admin section, resolve for a region. |
| `src/lib/actions/quote-documents.ts` | Writes: update, create region version, delete region version, create document, reorder. |
| `src/lib/actions/documents/terms.ts` | `setQuoteTerms`, `setDocumentExclusions`. |
| `src/lib/validation/quote-documents.ts` | Zod schemas for both of the above. |
| `src/app/(app)/documents/page.tsx` | The Documents list. |
| `src/app/(app)/documents/[key]/page.tsx` | One document's editor. |
| `src/components/quote-documents/*` | Editor, region tabs, palette, preview. |
| `src/components/builder/terms-documents-panel.tsx` | The builder panel. |
| `src/components/sheet/sections/documents-section.tsx` | Replaces three section components. |
| `scripts/migrate-content-blocks-to-quote-documents.ts` | One-shot data migration. |

**Deleted**

`src/components/sheet/sections/{terms,conditions,rsp}-section.tsx`, `src/app/(app)/settings/content/**`, `src/lib/queries/content.ts`, `src/lib/actions/content.ts`, `src/components/content/**`, `src/lib/content-placeholders.ts`, `src/lib/validation/content.ts`, `prisma/seed-data/content-blocks.json`, and from `src/lib/quotation-data.ts`: `resolveBlocks`, `collectByPrefix`, `ContentBlockRow`, `ResolvedContentBlock`, `RSP_COVERED_KINDS`, `QuotationRspRow`.

---

### Task 1: Schema

**Files:** `prisma/schema.prisma`, a new migration folder

- [ ] **Step 1: Add `QuoteDocument`**

```prisma
/// One whole legal document printed on a quote — Terms, General Conditions
/// of Sale, the RSP agreement, and whatever a region adds later. Replaces
/// the ContentBlock rows that held the same text as 7 and 14 separate
/// fragments: a lawyer hands over a document, not a list of clauses, and a
/// region variant is a copy of the whole thing rather than an override per
/// piece.
///
/// `regionId: null` is the global default; a non-null `regionId` is that
/// region's own version, resolved by the same two-pass rule ContentBlock
/// used (defaults first, then this region's rows, so an override wins
/// regardless of array order). A row may exist for a region with NO global
/// default — that is how a region-only document works, e.g. a Data
/// Processing Agreement offered only by an EU entity.
model QuoteDocument {
  id                String   @id @default(cuid())
  key               String // "terms" | "conditions" | "rsp" | future keys
  regionId          String?
  title             String // the printed heading
  body              String // HTML, may contain document-scope {{tokens}}
  sortOrder         Int      @default(0)
  /// Whether a new quote includes this document unless its author unticks
  /// it. Every document starts true; RSP is the one an author routinely
  /// turns off, for a small order nothing in the programme covers.
  includedByDefault Boolean  @default(true)
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt
  region            Region?  @relation(fields: [regionId], references: [id], onDelete: SetNull)

  @@unique([key, regionId])
  @@index([regionId])
}
```

- [ ] **Step 2: Add `DocumentExclusion`**

```prisma
/// A document an individual quote leaves out. Stores the document's `key`,
/// not its id, so the exclusion still means the same thing if the quote's
/// region changes and a different QuoteDocument row becomes the resolved
/// one. Absence means included — the common case writes no row at all.
model DocumentExclusion {
  documentId       String
  quoteDocumentKey String
  document         Document @relation(fields: [documentId], references: [id], onDelete: Cascade)

  @@id([documentId, quoteDocumentKey])
}
```

- [ ] **Step 3: Term values on `Region`**

```prisma
  /// The standard-terms figures the legal documents quote back at the
  /// customer. Region-level because a region is effectively its own
  /// company, with its own lead times and warranty. Defaults are the
  /// figures the original Word template carried and the code hardcoded
  /// until now (src/lib/quotation-data.ts's globalVars).
  deliveryWeeks    Int @default(14)
  installationDays Int @default(2)
  trainingDays     Int @default(3)
  warrantyMonths   Int @default(12)
```

- [ ] **Step 4: Term overrides and the snapshot on `Document`**

```prisma
  /// Per-quote overrides of the region's standard-terms figures — null
  /// means inherit. Delivery and warranty are negotiated per deal, and a
  /// signed quote promising 14 weeks when the salesperson agreed 10 is a
  /// commitment nobody made.
  deliveryWeeks     Int?
  installationDays  Int?
  trainingDays      Int?
  warrantyMonths    Int?
  /// Every rendered document body and every item's category copy, frozen
  /// when the quote went FINAL, with placeholders already substituted.
  /// Fixing a typo in General Conditions must not rewrite a quote signed
  /// three months ago. Written by finalizeDocument alongside
  /// entitySnapshot; overwritten wholesale on a re-finalize after
  /// unfinalizeDocument, exactly like entitySnapshot and the commission
  /// columns. Null on a DRAFT and on any quote finalised before this
  /// column existed — buildQuotationData falls back to live text then.
  documentsSnapshot Json?
  exclusions        DocumentExclusion[]
```

Add `quoteDocuments QuoteDocument[]` to `Region`.

- [ ] **Step 5: Hand-write the migration**

```bash
cd "/Users/vadym/Documents/PF Invoice"
ls prisma/migrations | sort -V | tail -3
```

Create `prisma/migrations/z<next>_quote_documents/migration.sql` with the two
`CREATE TABLE`s, their indexes and foreign keys, and the `ALTER TABLE`s adding
the columns. Every added column is nullable or has a default, so it applies to
a populated database without rewriting rows. Match the SQL style of the
existing migration files — read one first.

- [ ] **Step 6: Generate and verify**

```bash
cd "/Users/vadym/Documents/PF Invoice"
npx prisma generate && npm run typecheck
```

Expected: client regenerates; typecheck passes (nothing reads the new models yet).

- [ ] **Step 7: [LOCAL] Apply**

Vadym runs `npm run db:migrate`, then:

```bash
npx prisma db execute --stdin <<'SQL'
SELECT table_name FROM information_schema.tables
WHERE table_name IN ('QuoteDocument','DocumentExclusion');
SELECT column_name FROM information_schema.columns
WHERE table_name = 'Region' AND column_name LIKE '%Weeks' OR column_name LIKE '%Days' OR column_name LIKE '%Months';
SQL
```

- [ ] **Step 8: Commit**

```bash
cd "/Users/vadym/Documents/PF Invoice"
rm -f .git/index.lock .git/HEAD.lock
git add prisma/
git commit -m "feat: schema for whole quote documents

QuoteDocument holds a legal document as one body rather than the 7 and 14
ContentBlock fragments Terms and General Conditions were split into, so a
region variant is a copy of the whole thing. Term figures move off the
hardcoded literals onto Region, overridable per quote, and a FINAL quote
freezes what it printed."
```

---

### Task 2: Term resolution and document-scope tokens

**Files:** create `src/lib/quote-terms.ts`, modify `src/lib/quote-variables.ts`, test `tests/quote-terms.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/quote-terms.test.ts`:

```ts
// Pure — no DB, no next/*, same discipline as quote-variables.test.ts.
import { describe, it, expect } from "vitest";
import { resolveQuoteTerms } from "../src/lib/quote-terms";

const region = { deliveryWeeks: 14, installationDays: 2, trainingDays: 3, warrantyMonths: 12 };

describe("resolveQuoteTerms", () => {
  it("takes the region's figures when the quote overrides nothing", () => {
    expect(resolveQuoteTerms({}, region)).toEqual(region);
  });

  it("prefers a figure the quote sets", () => {
    expect(resolveQuoteTerms({ deliveryWeeks: 10 }, region).deliveryWeeks).toBe(10);
  });

  it("treats zero as a real override, not as absent", () => {
    // "Installation: 0 days" is a legitimate thing to promise for a
    // self-install; `??` gets this right where `||` would not.
    expect(resolveQuoteTerms({ installationDays: 0 }, region).installationDays).toBe(0);
  });

  it("overrides each figure independently", () => {
    const resolved = resolveQuoteTerms({ warrantyMonths: 24 }, region);
    expect(resolved.warrantyMonths).toBe(24);
    expect(resolved.deliveryWeeks).toBe(14);
  });
});
```

- [ ] **Step 2: Run it, watch it fail**

```bash
cd "/Users/vadym/Documents/PF Invoice"
npx vitest run tests/quote-terms.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Write the module**

```ts
// The standard-terms figures the legal documents quote back at the customer.
// Pure: no `@/lib/db`, no `next/*`, so `vitest run` needs no DATABASE_URL —
// same rule as quote-variables.ts and machine-specs.ts.

export type QuoteTermValues = {
  deliveryWeeks: number;
  installationDays: number;
  trainingDays: number;
  warrantyMonths: number;
};

/** Per-quote overrides. Null or absent means "inherit the region's". */
export type QuoteTermOverrides = Partial<Record<keyof QuoteTermValues, number | null>>;

/**
 * Quote value if it has one, region value otherwise. `??` rather than `||`
 * on purpose: 0 is a figure someone may legitimately promise (a self-install
 * with no installation days), and `||` would silently replace it with the
 * region's.
 */
export function resolveQuoteTerms(overrides: QuoteTermOverrides, region: QuoteTermValues): QuoteTermValues {
  return {
    deliveryWeeks: overrides.deliveryWeeks ?? region.deliveryWeeks,
    installationDays: overrides.installationDays ?? region.installationDays,
    trainingDays: overrides.trainingDays ?? region.trainingDays,
    warrantyMonths: overrides.warrantyMonths ?? region.warrantyMonths,
  };
}
```

- [ ] **Step 4: Add the document scope to the registry**

In `src/lib/quote-variables.ts`, mirror the category scope exactly — the same
`*_TOKEN_NAMES` const, derived `*_TOKENS` list, and a `source` string per
token, so the renderer's `vars` can be typed `Record<DocumentTokenName, …>`
and `tsc` enforces totality the way it already does for the category scope:

```ts
export const DOCUMENT_TOKEN_NAMES = [
  "deliveryWeeks", "installationDays", "trainingDays", "warrantyMonths",
  "bankDetails", "validityDate", "quoteNumber", "clientName",
] as const;
```

Sources, for the palette: delivery/installation/training/warranty say "From
this quote, or the region's default when the quote leaves it blank";
`bankDetails` "The region's bank details"; `validityDate` "The date this quote
expires"; `quoteNumber` "This quote's number, e.g. Q-AU-2026-001";
`clientName` "The customer's company name".

Document tokens are **not** category tokens and vice versa — `findUnknownTokens`
must reject `{{cutHeightCm}}` in a Terms document and `{{deliveryWeeks}}` in a
category's copy. Add tests both ways.

- [ ] **Step 5: Run, then commit**

```bash
cd "/Users/vadym/Documents/PF Invoice"
npx vitest run tests/quote-terms.test.ts tests/quote-variables.test.ts
npm run typecheck && npx tsc -p tests --noEmit && npm run lint && npm test
rm -f .git/index.lock .git/HEAD.lock
git add src/lib/quote-terms.ts src/lib/quote-variables.ts tests/
git commit -m "feat: resolve term figures from the quote, then the region

Delivery, installation, training and warranty stop being string literals in
quotation-data.ts. The document scope joins the registry so a Terms document
is offered exactly the tokens it can fill, and no category token."
```

---

### Task 3: Render documents instead of three fixed sections

**Files:** `src/lib/quotation-data.ts`, `tests/quotation-data.test.ts`

- [ ] **Step 1: Write the failing tests**

New describe block in `tests/quotation-data.test.ts`:

```ts
describe("quote documents", () => {
  const terms = { key: "terms", regionId: null, title: "Terms", body: "<p>Delivery in {{deliveryWeeks}} weeks.</p>", sortOrder: 10, includedByDefault: true };
  const conditions = { key: "conditions", regionId: null, title: "General Conditions of Sale", body: "<p>Clause.</p>", sortOrder: 20, includedByDefault: true };

  it("renders each included document with its own title, in sortOrder", () => {
    const data = buildQuotationData(quotationDoc(), [conditions, terms]);
    expect(data.documents.map((d) => d.title)).toEqual(["Terms", "General Conditions of Sale"]);
  });

  it("substitutes the quote's term figures", () => {
    const doc = quotationDoc({ deliveryWeeks: 10 });
    const data = buildQuotationData(doc, [terms]);
    expect(data.documents[0].bodyHtml).toContain("Delivery in 10 weeks");
  });

  it("falls back to the region's figure when the quote sets none", () => {
    const data = buildQuotationData(quotationDoc(), [terms]);
    expect(data.documents[0].bodyHtml).toContain("Delivery in 14 weeks");
  });

  it("prefers a region's own version of a document", () => {
    const regionTerms = { ...terms, regionId: "region-1", body: "<p>Mexican terms.</p>" };
    const data = buildQuotationData(quotationDoc({ regionId: "region-1" }), [terms, regionTerms]);
    expect(data.documents[0].bodyHtml).toContain("Mexican terms");
  });

  it("ignores another region's version entirely", () => {
    const otherTerms = { ...terms, regionId: "region-2", body: "<p>Wrong region.</p>" };
    const data = buildQuotationData(quotationDoc({ regionId: "region-1" }), [terms, otherTerms]);
    expect(data.documents[0].bodyHtml).toContain("Delivery in 14 weeks");
  });

  it("includes a region-only document that has no global default", () => {
    const dpa = { key: "dpa", regionId: "region-1", title: "Data Processing Agreement", body: "<p>DPA.</p>", sortOrder: 30, includedByDefault: true };
    const data = buildQuotationData(quotationDoc({ regionId: "region-1" }), [terms, dpa]);
    expect(data.documents.map((d) => d.key)).toEqual(["terms", "dpa"]);
  });

  it("leaves out a document this quote excludes", () => {
    const doc = quotationDoc({ excludedDocumentKeys: ["conditions"] });
    const data = buildQuotationData(doc, [terms, conditions]);
    expect(data.documents.map((d) => d.key)).toEqual(["terms"]);
  });

  it("leaves out a document not included by default unless the quote opts in", () => {
    const optional = { ...conditions, key: "optional", includedByDefault: false };
    const data = buildQuotationData(quotationDoc(), [terms, optional]);
    expect(data.documents.map((d) => d.key)).toEqual(["terms"]);
  });

  it("renders a FINAL quote from its snapshot, not from live text", () => {
    const doc = quotationDoc({
      isDraft: false,
      documentsSnapshot: { version: 1, documents: [{ key: "terms", title: "Terms", bodyHtml: "<p>As signed.</p>" }], itemCopyHtml: {} },
    });
    const data = buildQuotationData(doc, [{ ...terms, body: "<p>Edited since.</p>" }]);
    expect(data.documents[0].bodyHtml).toContain("As signed");
    expect(data.documents[0].bodyHtml).not.toContain("Edited since");
  });
});
```

- [ ] **Step 2: Run, watch it fail**

```bash
cd "/Users/vadym/Documents/PF Invoice"
npx vitest run tests/quotation-data.test.ts -t "quote documents"
```

- [ ] **Step 3: Implement**

Replace the `ContentBlockRow` input type with:

```ts
/** A `QuoteDocument` row exactly as stored — `regionId: null` is the global
 * default, a non-null `regionId` is that region's own version. */
export type QuoteDocumentRow = {
  key: string;
  regionId: string | null;
  title: string;
  body: string;
  sortOrder: number;
  includedByDefault: boolean;
};
```

Replace `resolveBlocks` with `resolveQuoteDocuments(rows, regionId)` — the same
two-pass reduction, keeping its doc comment's reasoning. Delete
`collectByPrefix`, `RSP_COVERED_KINDS`, `QuotationRspRow`, and the
`termsSections` / `conditionsSections` / `rsp` fields of `QuotationData`. Add:

```ts
export type QuotationDocumentSection = { key: string; title: string; bodyHtml: string };
```

and `documents: QuotationDocumentSection[]` on `QuotationData`.

`QuotationDataDoc` gains `deliveryWeeks`, `installationDays`, `trainingDays`,
`warrantyMonths` (all `number | null`), `excludedDocumentKeys: string[]`,
`documentsSnapshot: unknown`, and a `region` carrying the four region figures.

Build the document vars with `resolveQuoteTerms`, typed
`Record<DocumentTokenName, string | typeof OMIT>` so the registry stays
enforced. `validityDate`, `quoteNumber` and `clientName` come from the
`sheet` object `toSheetData` already returns.

Selection order: resolve per region → drop `!includedByDefault` unless opted in
→ drop `excludedDocumentKeys` → sort by `sortOrder`.

Snapshot: when `documentsSnapshot` parses to `{version: 1, documents, itemCopyHtml}`,
use it for `documents` and for each item's `titleBlockHtml` instead of
substituting live. Validate it defensively with a zod schema the way
`readProductSpecs` treats `Product.specs` — a malformed snapshot falls back to
live text rather than throwing on a customer-facing page.

- [ ] **Step 4: Run and commit**

```bash
cd "/Users/vadym/Documents/PF Invoice"
npm run typecheck && npx tsc -p tests --noEmit && npm run lint && npm test
rm -f .git/index.lock .git/HEAD.lock
git add src/lib/quotation-data.ts tests/
git commit -m "feat: assemble a quote's documents from QuoteDocument rows

Three hardcoded sections become one ordered list an admin controls, and a
FINAL quote renders from what it froze rather than from text edited since.
Drops the RSP coverage table: it never included FabricPro, its serial column
was never editable, and every price in it read TBA."
```

---

### Task 4: One section component instead of three

**Files:** create `src/components/sheet/sections/documents-section.tsx`; delete `terms-section.tsx`, `conditions-section.tsx`, `rsp-section.tsx`; modify `src/components/sheet/quotation-sheet.tsx:93-95`, `src/components/sheet/sheet-css.ts:604-628`

- [ ] **Step 1: Write the component**

```tsx
import type { QuotationData } from "@/lib/quotation-data";

/**
 * Every legal document this quote includes, in the order an admin set. One
 * component for all of them, where there used to be three hardcoded ones —
 * so adding a Data Processing Agreement for an EU entity is an admin's job
 * and touches no code. Each document's heading is its own `title`; the old
 * components hardcoded "Terms", "General Conditions of Sale" and "Remote
 * Support Program" in the markup.
 */
export function DocumentsSection({ documents }: { documents: QuotationData["documents"] }) {
  if (documents.length === 0) return null;

  return (
    <>
      {documents.map((doc) => (
        <section className="pq-section" key={doc.key}>
          <h1 className="pq-section-title">{doc.title}</h1>
          <div className="pq-flow-block pq-block-body" dangerouslySetInnerHTML={{ __html: doc.bodyHtml }} />
        </section>
      ))}
    </>
  );
}
```

- [ ] **Step 2: Mind the numbering**

`ConditionsSection` numbered its clauses `{index + 1}.` from array position.
A document is now one body, so its clauses are numbered by the author's own
ordered list in the editor. Nothing in code renumbers them. Confirm
`sheet-css.ts` styles `ol` inside `.pq-block-body` legibly; the old
`.pq-conditions-section` rules may have assumed the heading-per-clause shape.
Adjust rather than delete if so.

- [ ] **Step 3: Swap in `quotation-sheet.tsx`**

Replace the three elements at lines 93-95 with `<DocumentsSection documents={data.documents} />`.

- [ ] **Step 4: Remove the RSP table styles**

Delete `.pq-rsp-table` and its rules from `sheet-css.ts` (around 604-628).

- [ ] **Step 5: Verify and commit**

```bash
cd "/Users/vadym/Documents/PF Invoice"
npm run typecheck && npx tsc -p tests --noEmit && npm run lint && npm test
rm -f .git/index.lock .git/HEAD.lock
git add -A src/components/sheet
git commit -m "feat: print a quote's documents from one component

Three components hardcoding three headings become one loop over whatever
the admin ordered. Adding a document stops being a code change."
```

---

### Task 5: Queries

**Files:** create `src/lib/queries/quote-documents.ts`

- [ ] **Step 1: Write the three reads**

Model them on the deleted-later `src/lib/queries/content.ts` — read it first,
it solves the same problems:

- `getQuoteDocumentsForRegion(regionId)` — `OR: [{regionId: null}, {regionId}]`, for the renderer
- `listQuoteDocuments()` — every default plus which regions have their own version, for the admin list. Its `hasRegionOverrides` flag is the model for the list badge.
- `getQuoteDocument(key)` — the default, every region version, and the active regions, for the editor's tab strip

- [ ] **Step 2: Wire the renderer's two call sites**

`src/app/(app)/quotes/[documentId]/quotation/page.tsx` and
`src/app/api/quotes/[documentId]/quotation-pdf/route.ts` both call
`getContentBlocksForRegion(document.regionId)`. Point both at
`getQuoteDocumentsForRegion`.

- [ ] **Step 3: Verify and commit**

```bash
cd "/Users/vadym/Documents/PF Invoice"
npm run typecheck && npx tsc -p tests --noEmit && npm run lint && npm test
rm -f .git/index.lock .git/HEAD.lock
git add src/lib/queries/quote-documents.ts "src/app/(app)/quotes" src/app/api/quotes
git commit -m "feat: read quote documents for a region"
```

---

### Task 6: Actions

**Files:** create `src/lib/validation/quote-documents.ts`, `src/lib/actions/quote-documents.ts`

- [ ] **Step 1: Schemas and actions**

Five actions, all `requireAdmin()`, all returning `ActionResult`:
`updateQuoteDocument(key, regionCode|null, formData)`,
`createRegionVersion(key, regionCode)`, `deleteRegionVersion(key, regionCode)`,
`createQuoteDocument(formData)`, `reorderQuoteDocuments(keys)`.

Three things to carry over from `src/lib/actions/content.ts`, which solved them
already — read it before writing:

- **find-then-write, not upsert.** Postgres treats `NULL != NULL`, so the composite unique does not constrain default rows. A P2002 race is retried as an update.
- **`createRegionVersion` copies the default wholesale**, then diverges. Unlike the old `createRegionOverride` it must ALSO work when no default exists — that is a region-only document (D5), so accept a blank starting body in that case rather than erroring.
- **`sanitizeIfHtml` at the write boundary**, and `revalidate*` helpers rather than a bare `revalidatePath`.

Validate tokens against the **document** scope with `findUnknownTokens` and
`DOCUMENT_TOKENS`, exactly as `updateSeriesQuoteDescription` does for the
category scope — an out-of-scope token fails to save with a message naming it.

- [ ] **Step 2: Validation tests**

`tests/quote-documents-validation.test.ts`: key regex, title required, body
length, and — following the lesson from Plan 2 — that a body Tiptap produces
for an empty document (`<p></p>`, `<p><br></p>`) is rejected, since unlike a
category's copy a legal document must not be blank.

- [ ] **Step 3: Verify and commit**

```bash
cd "/Users/vadym/Documents/PF Invoice"
npm run typecheck && npx tsc -p tests --noEmit && npm run lint && npm test
rm -f .git/index.lock .git/HEAD.lock
git add src/lib/actions/quote-documents.ts src/lib/validation/quote-documents.ts tests/
git commit -m "feat: edit quote documents, region versions included

A region version is a copy of the whole document, and may exist with no
global default at all — that is how a region-only agreement works."
```

---

### Task 7: The Documents section

**Files:** `src/lib/nav-items.ts`, `src/app/(app)/documents/page.tsx`, `src/app/(app)/documents/[key]/page.tsx`, `src/components/quote-documents/*`

Before writing components, invoke the `pathquote-ui-ux-pro-max` skill.

- [ ] **Step 1: Nav**

Add to `NAV_ITEMS` after Catalog:

```ts
  { href: "/documents", label: "Documents", description: "Terms and conditions", icon: FileCheck },
```

`/documents` is free — Plan 1 moved quotes to `/quotes` precisely for this.
Note `NAV_ITEMS` has no role gating: every signed-in user sees every item, and
that is correct here. A manager may **read** documents (they need to know what
their client is signing — today `settings/content` is hidden from them
entirely) but not edit. Gate the editing affordances, not the route.

- [ ] **Step 2: The list page**

Three rows, each showing title, print order, and a "Customised for: US 2, UK"
badge. Model it on `src/app/(app)/settings/content/page.tsx`, minus the group
headers — there are no groups any more. Drag-to-reorder for admins only; reuse
`ProductReorderList`'s approach (`src/components/catalog/product-reorder-list.tsx`).
Managers get a plain list.

- [ ] **Step 3: The editor page**

Region tab strip, copied from `src/components/content/content-block-editor.tsx:43-53`:
Default plus one tab per active region, a dot on customised ones. Inside a tab:
full-width rich text holding the whole document, a variable palette of the
eight document tokens with their sources, a Preview button rendering the
document with sample values, and Create/Delete region version.

The palette follows the shape Plan 2 landed on in
`src/components/catalog/series-quote-description-card.tsx`: each token a
two-line block, token in monospace above its full source text, never a
tooltip. Read it and match it — an author should not meet two different
palettes in one product.

For a manager: the body renders read-only, no palette, no save, no region
creation. Do not `notFound()` them.

- [ ] **Step 4: [LOCAL] Check in a browser**

As an admin: all three documents listed; opening one shows the whole text in
one editor; creating a region version copies the default; editing the version
leaves the default alone; deleting it falls back. As a manager: everything
visible, nothing editable.

- [ ] **Step 5: Commit**

```bash
cd "/Users/vadym/Documents/PF Invoice"
npm run typecheck && npx tsc -p tests --noEmit && npm run lint && npm test
rm -f .git/index.lock .git/HEAD.lock
git add src/lib/nav-items.ts "src/app/(app)/documents" src/components/quote-documents
git commit -m "feat: a Documents section for the text a customer signs

Terms and General Conditions were 21 rows across two screens; they are two
documents now. Managers can read what their own client is signing, which
the admin-only content section never let them do."
```

---

### Task 8: The builder panel

**Files:** create `src/lib/actions/documents/terms.ts`, `src/components/builder/terms-documents-panel.tsx`; modify `src/app/(app)/quotes/[documentId]/page.tsx`, `src/lib/queries/documents-builder.ts`

- [ ] **Step 1: Actions**

`setQuoteTerms(documentId, input)` and `setDocumentExclusions(documentId, keys)`.
Model both on `setPriceDisplay` (`src/lib/actions/documents/presentation.ts:108-133`)
— `requireSession`, `documentWhereForUser`, `status: "DRAFT"` in the where
clause so a FINAL quote cannot be edited, `updateMany` guarded on the same,
`revalidateDocument`.

Term values validate as optional non-negative integers with a sane ceiling;
blank means null means inherit.

- [ ] **Step 2: The panel**

```
Delivery                [ 14 ] weeks      (region default: 14)
Installation            [  2 ] days       (region default: 2)
Training                [  3 ] days       (region default: 3)
Warranty                [ 12 ] months     (region default: 12)

Documents included in this quote
  [x] Terms
  [x] General Conditions of Sale
  [x] Remote Support Program
```

A blank field inherits and shows the region default as placeholder; a filled
one is marked as overridden. `PriceDisplayToggles`
(`src/components/builder/price-display-toggles.tsx`) is the closest existing
analogue for the checkbox half — optimistic local state, `useTransition`,
revert and toast on error, a read-only summary when `readOnly`.

Mount it in the left column of the builder between "Notes" and "Setup image".
`readOnly={!isDraft}` like every sibling panel.

- [ ] **Step 3: Feed the builder**

`getDocumentForBuilder` returns `Document` scalars implicitly, so the four term
columns arrive free. Add the region's four figures, the resolved document list
for the checkboxes, and the quote's exclusions.

- [ ] **Step 4: [LOCAL] Check**

Blank field inherits; a typed value shows on the preview; unticking RSP removes
that section from the sheet and the PDF; a FINAL quote's panel is read-only.

- [ ] **Step 5: Commit**

```bash
cd "/Users/vadym/Documents/PF Invoice"
npm run typecheck && npx tsc -p tests --noEmit && npm run lint && npm test
rm -f .git/index.lock .git/HEAD.lock
git add src/lib/actions/documents/terms.ts src/components/builder/terms-documents-panel.tsx "src/app/(app)/quotes" src/lib/queries/documents-builder.ts
git commit -m "feat: set a quote's terms and choose its documents

Delivery and warranty are negotiated per deal, so a quote may promise
something other than its region's default. RSP prints on every quote today
whether or not the customer bought it; now it is a tickbox."
```

---

### Task 9: Freeze on finalise

**Files:** `src/lib/actions/finalize.ts`

- [ ] **Step 1: Build and write the snapshot**

In `finalizeDocument`, beside `entitySnapshot` (`finalize.ts:75-86`), build:

```ts
{
  version: 1,
  documents: [{ key, title, bodyHtml }],   // fully substituted
  itemCopyHtml: { [itemId]: html },        // fully substituted category copy
}
```

Reuse `buildQuotationData` rather than re-implementing substitution — the
snapshot must be exactly what the preview showed. Write it inside the same
`$transaction`'s `updateMany` (`finalize.ts:209-219`) so a quote can never be
FINAL without one.

- [ ] **Step 2: Log the unfreeze**

`unfinalizeDocument` (`finalize.ts:255-275`) already returns a quote to DRAFT
and keeps its number. Add a `console.warn` naming the actor and the document,
matching the shape `finalizeDocument` already uses at `:158,168`. No audit
table (D12) — say so in the comment, and point at the same gap that one does.

Re-finalising overwrites the snapshot wholesale, exactly as it already
overwrites `entitySnapshot` and the commission columns. Say that in the doc
comment too.

- [ ] **Step 3: Tests**

`validateFinalizable` is pure and already tested; the snapshot build is not
pure. Cover what can be: that `buildQuotationData` prefers a snapshot over live
rows (already written in Task 3), and add a test that a snapshot missing its
`itemCopyHtml` entry for an item falls back to live copy for that item rather
than printing nothing.

- [ ] **Step 4: [LOCAL] Check**

Finalise a quote, edit General Conditions in the Documents section, reopen the
FINAL quote's PDF: unchanged. Unfinalise, re-finalise: the edit appears.

- [ ] **Step 5: Commit**

```bash
cd "/Users/vadym/Documents/PF Invoice"
npm run typecheck && npx tsc -p tests --noEmit && npm run lint && npm test
rm -f .git/index.lock .git/HEAD.lock
git add src/lib/actions/finalize.ts tests/
git commit -m "feat: freeze a quote's documents when it goes FINAL

Fixing a typo in General Conditions rewrote the PDF of every quote already
signed. A FINAL quote now renders what it froze; re-finalising after an
admin unfinalise picks up current text."
```

---

### Task 10: Migrate the legal text

**Files:** create `scripts/migrate-content-blocks-to-quote-documents.ts`

- [ ] **Step 1: Write the script**

Follow `scripts/migrate-content-blocks-to-series.ts` — it was hardened for
exactly this job and its shape is the house pattern now: dry-run by default,
a full backup JSON written before any write, one transaction, idempotent, an
exit-code contract of 0 clean / 1 unexpected / 2 skip-only.

Mapping:

| From | To |
|---|---|
| `terms.*` × 7, in `sortOrder` | one `QuoteDocument` `key: "terms"`, `title: "Terms"`, `sortOrder: 10` |
| `conditions.1` … `conditions.14`, in `sortOrder` | one `key: "conditions"`, `title: "General Conditions of Sale"`, `sortOrder: 20` |
| `rsp.agreement` | one `key: "rsp"`, `title: "Remote Support Program"`, `sortOrder: 30` |
| `rsp.coverage-note` | deleted — never rendered by anything |

Assembling the bodies is the substance of this task:

- **Terms:** each block becomes an `<h2>` of its title followed by its body. A block with no title contributes its body alone.
- **Conditions:** an `<ol>` whose items are the 14 clauses in `sortOrder`, each `<li>` opening with its title in `<strong>`. The renderer used to number these by array position; the numbering is now the list's.
- Bodies are markdown today. Convert with `renderStoredRichText`, the same function the renderer already uses, then `sanitizeIfHtml` — do not hand-roll a converter.

**Region versions:** for each region holding an override of *any* block in a
group, assemble that region's whole document — its own row where it has one,
the default elsewhere — and write it as a `QuoteDocument` with that `regionId`.
This is the one place the migration creates something that did not exist as a
unit before; log each region document with which blocks came from the override
and which from the default.

**Dead tokens:** `{{rspYear2Cost}}` in `terms.rsp` has no source and never had
one. Report it as a `[WARN]` naming the document and setting a non-zero exit —
the same treatment the category migration gives an out-of-scope token. Do not
strip it silently: an admin must decide what that clause should say.

- [ ] **Step 2: [LOCAL] Dry-run, read, apply**

```bash
cd "/Users/vadym/Documents/PF Invoice"
npx tsx scripts/migrate-content-blocks-to-quote-documents.ts
npx tsx scripts/migrate-content-blocks-to-quote-documents.ts --apply
```

Read the assembled bodies in the dry run before applying. This is the text a
customer signs; a mangled `<ol>` is worth catching here rather than on a quote.

- [ ] **Step 3: [LOCAL] Verify**

```bash
npx prisma db execute --stdin <<'SQL'
SELECT key, "regionId", title, length(body) FROM "QuoteDocument" ORDER BY "sortOrder", key;
SELECT count(*) FROM "ContentBlock";
SQL
```

Expected: three default documents plus any region versions; `ContentBlock`
empty.

- [ ] **Step 4: Commit**

```bash
cd "/Users/vadym/Documents/PF Invoice"
npm run typecheck && npx tsc -p tests --noEmit && npm run lint && npm test
rm -f .git/index.lock .git/HEAD.lock
git add scripts/
git commit -m "chore: assemble the legal blocks into whole documents

21 rows across terms and conditions become two documents, with each
region's scattered overrides gathered into one document of its own."
```

---

### Task 11: Retire `ContentBlock`

**STOP.** Do not start this task until Vadym confirms Task 10 was applied
against the database, and that Plan 2's
`scripts/migrate-content-blocks-to-series.ts --apply` was too. Both moved data
out of tables this task drops. An agent cannot check either. Ask.

**Files:** `prisma/schema.prisma`, a migration, and the deletions listed under File structure

- [ ] **Step 1: Confirm nothing reads it**

```bash
cd "/Users/vadym/Documents/PF Invoice"
grep -rn "contentBlock\|ContentBlock" src/ prisma/ scripts/ tests/ --include=*.ts --include=*.tsx -i
```

Every hit should be in the two migration scripts, the schema, the seed, or the
files this task deletes. Anything else is a reader — stop and deal with it.

- [ ] **Step 2: Delete the code**

The `settings/content` routes, `queries/content.ts`, `actions/content.ts`,
`components/content/**`, `content-placeholders.ts`, `validation/content.ts`,
`tests/content-validation.test.ts`, and `prisma/seed-data/content-blocks.json`
with the seed code that loads it.

Remove the "Content blocks" tab from `src/components/settings/catalogue-subnav.tsx`
and narrow its `active` union. Remove the Catalogue entry's `activePrefixes`
in `src/lib/settings-nav.ts` if it named the content route.

- [ ] **Step 3: Drop the columns and the table**

Remove `model ContentBlock`, `Product.contentBlockKey` and
`Option.contentBlockKey`, then hand-write the migration:

```sql
-- AlterTable
ALTER TABLE "Product" DROP COLUMN "contentBlockKey";

-- AlterTable
ALTER TABLE "Option" DROP COLUMN "contentBlockKey";

-- DropTable
DROP TABLE "ContentBlock";
```

- [ ] **Step 4: The catalog spreadsheet**

Both `contentBlockKey` columns are in the xlsx import/export
(`src/lib/catalog-xlsx/{columns,export,parse,apply-plan,snapshot}.ts`).
Remove them. `tests/catalog-xlsx-parse.test.ts` asserts the column list against
the schema, so it will fail until both agree — that is the test working.
Update `tests/helpers/catalog-xlsx.ts` too.

An export made before this change carries two columns the importer will not
know. Check how `parse.ts` treats an unrecognised column: if it errors, make it
ignore these two by name with a comment saying why, so an in-flight spreadsheet
on someone's desktop does not break.

- [ ] **Step 5: Verify, [LOCAL] apply, commit**

```bash
cd "/Users/vadym/Documents/PF Invoice"
npx prisma generate && npm run typecheck && npx tsc -p tests --noEmit && npm run lint && npm test
```

Vadym runs `npm run db:migrate`.

```bash
rm -f .git/index.lock .git/HEAD.lock
git add -A
git commit -m "refactor: retire ContentBlock

Category copy lives on the category, option copy on the option, and legal
text in QuoteDocument. Nothing resolved a block key any more."
```

---

### Task 12: Seed the documents

**Files:** `prisma/seed.ts`, `prisma/seed-lib.ts`, new `prisma/seed-data/quote-documents.json`

- [ ] **Step 1: Seed data**

A fresh database must come up with the three documents, or a new developer's
quotes print no legal text at all. Export the migrated bodies into
`prisma/seed-data/quote-documents.json` and seed them create-if-absent, keyed
on `(key, regionId)` — the rule `content-blocks.json` already followed, so
re-seeding never overwrites an admin's edit.

Seed the four `Region` term figures from the column defaults; do not write them
in the seed data, or changing a region's delivery time would be undone by the
next `db:seed`.

- [ ] **Step 2: Update the mappers and their tests**

`prisma/seed-lib.ts` (`ContentBlocksJson`, `mapContentBlocks`) becomes the
quote-document equivalent. `tests/seed-mapping.test.ts` covers it.

- [ ] **Step 3: Verify and commit**

```bash
cd "/Users/vadym/Documents/PF Invoice"
npm run typecheck && npx tsc -p tests --noEmit && npm run lint && npm test
rm -f .git/index.lock .git/HEAD.lock
git add prisma/ tests/
git commit -m "chore: seed the three quote documents

A fresh database printed no Terms at all once ContentBlock was gone."
```

---

## Self-review notes

**Spec coverage.** D1 (region-only scoping, throughout), D2 (Tasks 6, 7, 10),
D4 (Tasks 2, 8), D5 (Tasks 3, 6, 8), D6 (Tasks 2, 6), D7 (Task 9), D10
(Task 3), D12 (Task 9). D3, D8 and D9 belonged to Plan 2.

**Ordering constraints.** Task 4 depends on 3; 8 on 6 and 2; 9 on 3; 11 on 10
being applied *and* on Plan 2's category migration being applied; 12 on 11.
Tasks 5, 6 and 7 can proceed in parallel with 8 and 9.

**Type consistency.** `QuoteDocumentRow` (Task 3) is the row shape everywhere;
`QuotationDocumentSection` (`{key, title, bodyHtml}`) is the rendered shape and
is what the snapshot stores. `resolveQuoteTerms(overrides, region)` takes the
quote's overrides first — the same argument order as the precedence it
implements. `DOCUMENT_TOKEN_NAMES` mirrors `CATEGORY_TOKEN_NAMES`, and both
gain their totality guarantee from the renderer's `vars` being typed as a
`Record` over them.

**Known risk.** Task 10 assembles the text a customer signs, from 22 rows into
3 documents, and its output cannot be checked in CI. Its dry run must be read
by a human before `--apply`. Nothing else in this plan is irreversible except
Task 11, which is gated on that.
