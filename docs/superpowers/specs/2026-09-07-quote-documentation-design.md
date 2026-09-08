# Quote Documentation Restructure — Design

Date: 2026-09-07
Status: Approved (design), pending implementation plan

## Problem

All quote text — product copy and legal terms alike — lives in a single
`ContentBlock` table (52 rows, keyed `terms.delivery`, `conditions.4`,
`machine.m-series`, `option.MTS`, …). Four consequences:

1. **No whole-document view.** General Conditions of Sale is 14 separate rows.
   Editing it means visiting 14 screens. Creating a regional variant means
   overriding 14 rows one at a time.
2. **Variables are undocumented and unscoped.** Three different variable scopes
   exist with no indication of which applies where. A block can reference
   `{{cutHeightCm}}` for a product that has no cut height; the engine silently
   deletes the entire source line, and nobody learns that a sentence vanished
   from a signed document.
3. **Global variables are hardcoded.** `deliveryWeeks="14"`,
   `installationDays="2"`, `trainingDays="3"`, `warrantyMonths="12"` are string
   literals in `src/lib/quotation-data.ts:671-677`. There is no settings screen
   for them, which is why they could not be found.
4. **Product copy is orphaned from the catalog.** `contentBlockKey` sits on
   `Product`, but only 27 of 57 products have one. L-Series (8 machines), LNS,
   EasyFeeder, HDRF and Service render with no descriptive text at all.
   X-Calibre borrows the block literally named `machine.m-series`.

Additionally, FINAL quotes render legal text **live** from the database. Fixing
a typo in General Conditions retroactively changes the PDF of a quote signed
three months ago.

## Decisions

| # | Decision |
|---|---|
| D1 | Region stays the only scoping axis. A Region is effectively a separate company (USA 1, USA 2 may coexist). No country, locale, or per-customer scope. |
| D2 | Legal text is edited as a whole document, not as inherited sections. A regional variant is a full copy that then diverges. |
| D3 | Product copy is one template per category (currently modelled as `Series`). No per-product exceptions. |
| D4 | Delivery/installation/training/warranty values default from the Region and are overridable on an individual quote. |
| D5 | The set of documents printed on a quote is configured per region and ordered; an individual quote may exclude a document via a checkbox. No conditional rule engine. |
| D6 | Unknown variables are rejected at save time (scope-aware validation). Valid-but-unresolvable variables strip their line as today, plus a draft-only warning banner listing what was removed. |
| D7 | Legal text and category copy are frozen into the quote at FINAL. Only an admin may unfreeze. |
| D8 | Option-level copy is removed entirely. Options are already enumerated in the options table with name, attributes line, quantity and price. |
| D9 | "Series" is relabelled "Category" in the UI only. The Prisma model, columns and routes keep the `Series` name. A full rename is a separate task. |
| D10 | The RSP coverage table is removed now. RSP becomes a plain text document. The table returns with the real RSP pricing work. |
| D11 | The quote routes move from `/documents` to `/quotes`, freeing `/documents` for this feature. The Prisma model stays `Document`, as with D9. |
| D12 | Unfreezing reuses the existing admin-only `unfinalizeDocument`. It logs to the console in the shape `finalizeDocument` already uses; a real audit-log table is out of scope. |

### Corrections made after reading the code

Four findings from the implementation survey changed decisions above. They are
recorded here rather than silently edited in, because the earlier reasoning is
worth keeping.

**`Option.shortDescription` stays.** It already does what D8 wants: adding an
option to a quote snapshots `Option.shortDescription` into the line's
`description` (`src/lib/actions/documents/options.ts:229-233`), so option text
already comes from the option. It is also shown on the `/catalog/options` list
and in the option edit form. Only `Option.contentBlockKey` and the `option.*`
blocks are removed; option rows keep printing their description, now from the
one source that owns it.

**The nav label `Documents` was taken.** `/documents` is the quotes section
(`src/lib/nav-items.ts:5`), hence D11.

**No audit-log infrastructure exists.** No audit or activity model is in the
schema; `finalizeDocument` writes `console.warn("[finalize] admin override: …")`
with a comment saying there is nowhere better yet
(`src/lib/actions/finalize.ts:158,168`). Hence D12.

**There is no Series edit page.** `/catalog/[seriesId]` lists a series' products
and carries one admin-only `SeriesImageCard`. The quote-description editor
becomes a second such card. No `createSeries`/`updateSeries` action exists — the
only Series write in the codebase is `updateSeriesImage`
(`src/lib/actions/catalog/images.ts:62-77`), so a new action is required.

## Data model

### New: `QuoteDocument`

```prisma
model QuoteDocument {
  id                String   @id @default(cuid())
  key               String   // "terms" | "conditions" | "rsp" | future keys
  regionId          String?  // null = global default
  title             String   // printed heading
  body              String   // HTML — the entire document
  sortOrder         Int
  includedByDefault Boolean  @default(true)
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt
  region            Region?  @relation(fields: [regionId], references: [id], onDelete: SetNull)

  @@unique([key, regionId])
  @@index([regionId])
}
```

Resolution mirrors the proven `resolveBlocks` two-pass approach: load
`OR: [{ regionId: null }, { regionId }]`, apply defaults first, then this
region's rows, so an override always wins regardless of array order.

A row may exist for a region with no global default. That is how a region-only
document is created — a Data Processing Agreement offered only by the EU
entity, say. This differs from the current `createRegionOverride`, which
requires a default to exist first.

Writes use find-then-write rather than upsert, because Postgres treats
`NULL != NULL` and the composite unique does not constrain default rows. A
P2002 race is retried as an update. This is the existing pattern in
`src/lib/actions/content.ts:41-47,88-93` and carries over unchanged.

### New: `DocumentExclusion`

```prisma
model DocumentExclusion {
  documentId       String
  quoteDocumentKey String   // stores key, not id
  document         Document @relation(fields: [documentId], references: [id], onDelete: Cascade)

  @@id([documentId, quoteDocumentKey])
}
```

Storing `key` rather than `id` keeps the exclusion meaningful if the quote's
region changes and a different `QuoteDocument` row becomes the resolved one.

### Changed: `Series`

```prisma
quoteDescription String?   // HTML, may contain category-scope variables
```

Category copy moves out of `ContentBlock` and into the catalog, next to the
prices and specifications it describes. Empty means nothing is printed under
the product name.

### Changed: `Region`

```prisma
deliveryWeeks    Int @default(14)
installationDays Int @default(2)
trainingDays     Int @default(3)
warrantyMonths   Int @default(12)
```

Explicit columns rather than JSON, so validation and the settings form stay
direct.

### Changed: `Document` (the quote)

```prisma
deliveryWeeks     Int?     // null = inherit from region
installationDays  Int?
trainingDays      Int?
warrantyMonths    Int?
documentsSnapshot Json?    // frozen at FINAL
```

### Removed

- Model `ContentBlock` and its migration, seed data and admin routes
- `Product.contentBlockKey`
- `Option.contentBlockKey`
`Option.shortDescription` is **kept** — see the corrections note above.

## Variables

Two scopes, each owned by the entity that supplies the data.

### Category scope — `Series.quoteDescription`

| Variable | Source | Present in |
|---|---|---|
| `{{model}}` | `DocumentItem.code` (snapshot of `Product.code`) | all |
| `{{name}}` | `Product.name` | all |
| `{{price}}` | line total including options | all |
| `{{basePrice}}` | machine price excluding options | all |
| `{{cutHeightCm}}` | `Product.specs.cutHeightCm` | M, X |
| `{{cutWidthCm}}` | `Product.specs.cutWidthCm` | M, X, L, FP |
| `{{tableWidthMm}}` | `Product.specs.tableWidthMm` | EL, EF |
| `{{paperWidthMm}}` | `Product.specs.paperWidthMm` | EF |

The editor offers only the variables present in that category's product specs.
L-Series products carry no `cutHeightCm`, so the token is neither offered nor
accepted there. This is what makes the "a table cannot reference cut height"
problem structural rather than a matter of discipline.

`{{specSentence}}` (`src/lib/machine-specs.ts:21-28`) is retained as-is — it is
generated, not authored.

### Document scope — `QuoteDocument.body`

| Variable | Source |
|---|---|
| `{{deliveryWeeks}}` | quote value, else region |
| `{{installationDays}}` | quote value, else region |
| `{{trainingDays}}` | quote value, else region |
| `{{warrantyMonths}}` | quote value, else region |
| `{{bankDetails}}` | `Region.bankDetails` (via `entitySnapshot` on FINAL) |
| `{{validityDate}}` | `Document.validityDate` |
| `{{quoteNumber}}` | `Document.number` |
| `{{clientName}}` | `Company.name` |

The last three are new.

### Removed variables

`{{metres}}`, `{{tables}}`, `{{tableQty}}`, `{{totalLengthM}}`, `{{lengthM}}` —
the per-option-line `attributeVars` mechanism
(`src/lib/quotation-data.ts:453-460`) goes with D8.

`{{rspYear2Cost}}`, `{{productName}}`, `{{serialNumber}}`, `{{rspUnitCost}}`,
`{{covered}}` — documented in `content-blocks.json` but never had a source in
code, so their lines were always stripped. They return with the RSP work.

### Unresolved-value behaviour

- **Save time:** a token outside the editor's scope is a validation error. The
  document cannot be saved.
- **Draft preview:** a valid token with no value for this product strips its
  line, as today, and raises a banner above the preview naming what was removed
  and why (`"Removed 1 line: cutHeightCm has no value for L-180"`).
- **Final PDF:** stripped silently. No banner.

## User interface

### Documents (new top-level menu item)

`Settings → Content` is removed, along with its tab in `CatalogueSubnav`
(`src/components/settings/catalogue-subnav.tsx`), which keeps its other two.

The quotes section moves from `/documents` to `/quotes` and is relabelled
**Quotes** in `NAV_ITEMS` (D11). **Documents** then takes `/documents` and sits
alongside Catalog. Only the route segments and hrefs move; the Prisma `Document`
model and the `src/lib/**/documents*` module paths keep their names.

List view: three rows — Terms, General Conditions of Sale, Remote Support
Program — each showing print order and a badge naming the regions that have
their own version. Order is set by drag-and-drop.

Editor: region tab strip (Default plus one tab per active region, dot on
customised regions), reusing the pattern in
`src/components/content/content-block-editor.tsx:43-53`. Inside a tab:

- full-width rich text editor holding the entire document, with ordered-list
  support for GCS clauses
- variable palette listing the eight document-scope tokens with their sources;
  clicking inserts
- **Preview** button rendering the document with sample values as the client
  will see it
- **Create regional version** (full copy of Default) and **Delete version**
  (falls back to Default)

### Permissions

| | Admin | Manager |
|---|---|---|
| View documents | yes | yes |
| Edit documents | yes | no |
| Edit category copy | yes | no |
| Set quote term values | yes | yes |
| Exclude a document from a quote | yes | yes |
| Unfreeze a FINAL quote | yes | no |

Managers currently cannot see the content section at all
(`settings/content/page.tsx:44` calls `notFound()` for MANAGER), meaning they
cannot read what their own client is signing. Read access fixes that.

### Catalog — category page

`/catalog/[seriesId]` gains a second admin-only card beside the existing
`SeriesImageCard`: **Quote description**, a rich text editor plus a variable
palette filtered to that category's product specs. Empty prints nothing. This
needs a new `updateSeriesQuoteDescription` action — the only existing Series
write is `updateSeriesImage`.

### Quote builder — Terms & Documents panel

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

An empty field inherits the region value. A filled field is visually marked as
overridden.

### Finalisation

Moving to FINAL writes `documentsSnapshot` — the resolved bodies of every
included document and of each item's category copy, after variable
substitution. The FINAL PDF renders from the snapshot.

An admin may unfreeze through the existing `unfinalizeDocument`
(`src/lib/actions/finalize.ts:255-275`), which already returns the quote to
DRAFT while keeping its number. Re-finalising overwrites the snapshot with
current text, exactly as it already overwrites `entitySnapshot` and the frozen
commission columns. Per D12 the action gains a `console.warn` line matching
`finalizeDocument`'s existing override logging; no audit table is introduced.

## Render pipeline

`src/components/sheet/quotation-sheet.tsx` loses three components and gains one:

```tsx
<DocumentsSection documents={data.documents} />
```

which iterates the included documents in `sortOrder`. Adding a document (for
example a Data Processing Agreement for the EU) becomes an admin task.

Deleted:

| Path | What |
|---|---|
| `src/components/sheet/sections/terms-section.tsx` | whole file |
| `src/components/sheet/sections/conditions-section.tsx` | whole file |
| `src/components/sheet/sections/rsp-section.tsx` | whole file |
| `src/lib/quotation-data.ts:132-146` | `resolveBlocks` |
| `src/lib/quotation-data.ts:453-460` | `attributeVars` |
| `src/lib/quotation-data.ts:475-488` | `collectByPrefix` |
| `src/lib/quotation-data.ts:160,687-697` | `RSP_COVERED_KINDS`, coverage rows |
| `src/app/(app)/settings/content/**` | whole section |
| `src/lib/queries/content.ts`, `src/lib/actions/content.ts` | replaced by document equivalents |
| `src/components/sheet/sheet-css.ts:604-628` | RSP table styles |

`equipment-detail.tsx` keeps both `attributesLine` (the "× 3 tables, 12 m" line
under an option name) and `descriptionHtml` on option rows
(`equipment-detail.tsx:141-146`). What changes is where `descriptionHtml` comes
from: the `Option.contentBlockKey` lookup is dropped, leaving the line's own
snapshot description, which is copied from `Option.shortDescription` when the
option is added. Item copy comes from `Series.quoteDescription`, falling back to
`specSentence` as today.

The hardcoded headings "Terms", "General Conditions of Sale" and "Remote Support
Program" move into `QuoteDocument.title`.

## Migration

| From | To |
|---|---|
| `terms.*` (7 blocks, sortOrder 30–36) | one `QuoteDocument` `key="terms"`, bodies concatenated in `sortOrder` |
| `conditions.1`…`conditions.14` | one `QuoteDocument` `key="conditions"` as an ordered list |
| `rsp.agreement` | `QuoteDocument` `key="rsp"` |
| `rsp.coverage-note` | deleted (never rendered) |
| `option.*` (17 blocks) | deleted |
| `machine.m-series` | copied into `Series.quoteDescription` for both M and X; X is then edited separately |
| `equipment.easy-loader` | `Series` EL |
| `equipment.fabric-pro` | `Series` FP |
| `equipment.fabric-master`, `equipment.spreading-table`, `software.*` (6) | deleted — no matching category exists in the catalog |

Regional overrides are assembled into whole documents: for each region holding
any override in a group, the region's row is taken where present and the default
elsewhere, producing a complete regional document.

Categories left without copy — **L-Series, Leather Nesting System, EasyFeeder,
Heavy Duty Roll Feeder, Service** — are written by hand from the Pathfinder
Brain (`02 Products/L-Series.md`, `Leather Nesting System.md`,
`EasyLoader & EasyFeeder.md`, `Roll Feeding.md`, `Software Overview.md`) using
the existing quote `RAW/AAAM Series Australian Sale Template02 (1).docx` for
tone and structure. These categories currently render with no text at all, so
this closes an existing gap rather than causing a regression.

Existing demo quotes may break; they are disposable.

## Testing

Rewrite `tests/quotation-data.test.ts:638-684`, which locks in the removed RSP
coverage behaviour.

New coverage:

- variable resolution precedence: quote value over region default
- region fallback with and without an override present
- scope validation: an out-of-scope token fails to save
- line stripping plus draft banner; clean output in FINAL
- snapshot freeze: editing a document after FINAL does not change that quote's PDF
- per-quote exclusion removes exactly one document and preserves order

## Risks

**GCS clause numbering becomes manual.** The current renderer renumbers by array
index (`conditions-section.tsx:18`). A rich text ordered list covers this, but
pasting text from a lawyer requires attention to list formatting.

**Regional overrides for product copy are dropped.** Technically possible today,
believed unused. A machine cuts 3 cm the same in Mexico City and Sydney. If it
is ever needed, an override table is added without disturbing the rest.

## Out of scope

RSP pricing: per-region rates, quantity-based discounts (a second machine costs
less), coverage across all cutting machines plus FabricPro, and the coverage
table itself. Tracked separately in
`docs/plans/meeting-john-wayne-feature-backlog.md:140-148`.

A full `Series` → `Category` rename through the schema, routes and seeds (D9).
