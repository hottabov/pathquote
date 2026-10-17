# P0: quote correctness + invoice removal — design

Date: 2026-09-01
Branch: `feat/p0-quote-correctness` (worktree `.worktrees/p0`)
Source: owner feedback + demo meeting with John and Wayne (`docs/plans/meeting-john-wayne-feature-backlog.md`)

## Context

Two problems, one sprint.

**The base machine price is invisible.** A quote line prints a single figure that
is base price + all options, so the customer cannot see what the machine itself
costs. Wayne named it directly in the demo: *"we have included options, but we
don't have the base model."* The data is not lost — `DocSheetItem` already
carries both `unitPrice` (base) and `total` — but only one of three renderers
prints the base, and the other two collapse to the combined number.

**Invoices do not belong in this tool.** Invoicing is the accountant's job in
their own system. Every invoice code path is dead weight that doubles the
branching in the shared renderers and will keep costing merge pain.

Fixing both together is deliberate: the invoice branches live in exactly the
files the base-price fix has to touch (`sheet-data.ts`, `document-sheet.tsx`,
`documents/[documentId]/page.tsx`). Doing them separately means editing the
same code twice.

## Goals

1. Base machine price visible on every surface that shows a price.
2. Quantity column showing `1` per product line (display only).
3. `Valid until` date visible in the Total Investment block, overridable per quote.
4. Page numbers in PDF footers.
5. Extra lines accept negative amounts (trade-in) and a photo.
6. Discounts can be a percentage or a fixed cash amount, at item and document level.
7. Invoice support removed completely — code, schema, tests, data.
8. `Region` becomes `Distributor` everywhere, and a distributor holds several
   bank accounts rather than one blob.

## Non-goals

- Production order forms. Being built in parallel on `.worktrees/forms`. Nothing
  in this spec touches that feature; the invoice removal makes one of its edge
  cases (`an INVOICE renders no forms`) moot, which that branch handles on rebase.
- Multiplying prices by quantity. A product line is always one machine. More
  machines means more lines. Confirmed by the owner.
- Structured trade-in records (model / serial / removal responsibility as
  columns). The free-text description field already carries that.
- Customer signing portal (backlog items 16 / 16b). Separate spec.

---

## Part A — remove invoice support

### A1. Data model

`Document.type` only ever holds `QUOTE` after this change, so the column, the
enum, and the `NumberSequence.docType` discriminator all go. Leaving a
single-value enum behind would be a trace of the feature, not a simplification.

Schema changes in `prisma/schema.prisma`:

- Delete `enum DocumentType` (`:14-17`).
- Delete `Document.type` (`:229`).
- Delete `Document.sourceQuoteId`, the `sourceQuote` / `invoicesFromQuote`
  self-relation `QuoteToInvoice`, and `@@index([sourceQuoteId])` (`:263-270`, `:277`).
- Delete `NumberSequence.docType`; the unique constraint becomes
  `@@unique([regionCode, year])`.
- Rewrite the stale comment on `showItemPrices` / `showOptionPrices` (`:252-260`)
  which currently explains invoice behaviour.

### A2. Migration

New migration `z10_remove_invoices`, ordered so no step depends on an object a
previous step dropped. Invoice rows are deleted outright — confirmed by the
owner; there is no archive step.

```sql
-- 1. purge invoice documents; items and lines cascade
DELETE FROM "Document" WHERE "type" = 'INVOICE';

-- 2. purge invoice number counters
DELETE FROM "NumberSequence" WHERE "docType" = 'INVOICE';

-- 3. drop the quote->invoice backlink
ALTER TABLE "Document" DROP CONSTRAINT "Document_sourceQuoteId_fkey";
DROP INDEX "Document_sourceQuoteId_idx";
ALTER TABLE "Document" DROP COLUMN "sourceQuoteId";

-- 4. drop the discriminators and the enum they share
DROP INDEX "NumberSequence_regionCode_docType_year_key";
ALTER TABLE "NumberSequence" DROP COLUMN "docType";
CREATE UNIQUE INDEX "NumberSequence_regionCode_year_key"
  ON "NumberSequence"("regionCode", "year");
ALTER TABLE "Document" DROP COLUMN "type";
DROP TYPE "DocumentType";
```

`Document.type` has no column default, so no default needs dropping first.
Step 2 must run before step 4 or the `docType` predicate has no column to read.

Deleting the column instead of rewriting the enum avoids the
`CREATE TYPE ..._new` / cast / swap dance entirely — Postgres cannot drop an
enum value in place, but it has no trouble dropping the whole type once nothing
references it.

### A3. Code deleted outright

- `src/lib/invoice-from-quote.ts` (whole file)
- `src/components/builder/create-invoice-button.tsx` (whole file)
- `createInvoiceFromQuote` and its section in `src/lib/actions/documents.ts:850-1042`
- `tests/invoice-from-quote.test.ts` (whole file)
- The "New invoice" buttons on the dashboard (`src/app/(app)/page.tsx:55-60`) and
  the documents list (`src/app/(app)/documents/page.tsx:66-80`)
- The `TABS` type filter on the documents list (`:28-52`) — with one document
  type there is nothing to filter
- The "From quote {number}" backlink block (`documents/[documentId]/page.tsx:266-278`)

### A4. Branches that collapse to constants

| Location | Now | After |
|---|---|---|
| `sheet-data.ts:492-521` | `isQuote` gates `title`, `validUntil`, `showSignature` | `title: "QUOTATION"`, `showSignature: true`, `validUntil` always computed |
| `sheet-data.ts:98, 231` | `type: "QUOTE" \| "INVOICE"` in types | field removed |
| `numbering.ts:9-23, 53` | `NUMBER_PREFIX` map, `type` parameter | `Q` prefix constant; `formatDocNumber` / `allocateNumber` drop the parameter |
| `actions/documents.ts:114-150` | `createDraft(type)` | `createDraft()` |
| `validation/documents.ts:18-19` | `documentTypeSchema` | deleted |
| `finalize.ts:86-88` | validity days set only for quotes | always set |
| `quotation-pdf/route.ts:32`, `quotation/page.tsx:29` | `type !== "QUOTE"` guards | guards removed |
| `preview/page.tsx:56-95` | quote/invoice labels and conditional links | quote wording, links unconditional |
| `documents/page.tsx`, `(app)/page.tsx`, `sticky-footer.tsx` | `FileText` vs `Receipt` icon branch | `FileText`; `Receipt` import removed |
| `documents/[documentId]/page.tsx:179-190` | `PriceDisplayToggles` gated on quote | always rendered |

`src/components/sheet/document-sheet.tsx` is **not** deleted. It renders the
one-page summary sheet of a quote — the version the meeting asked to hand to
Martin — and after this change it simply stops being shared between two document
types.

### A5. Wording

Strings that say "quotes and invoices" become "quotes":
`clients/[companyId]/page.tsx:109`, `actions/clients.ts:180`,
`nav-items.ts:10`, `region-form.tsx:210` (bank details helper),
`documents/page.tsx:61-62, 134`, `(app)/page.tsx:43-44, 78, 89`.

Repo-level names (`README.md` title, the git remote `pf-invoice`, the deploy key
in `docs/runbook.md`) are **out of scope** — renaming them touches CI and the
VPS without changing app behaviour.

---

## Part B — shared line presenter

### B1. Problem

Three surfaces render a product line and each decides for itself how to show the
money:

- `quotation-sheet.tsx:318-348` — base, then options, then a subtotal row that
  only appears when the item has options. Correct.
- `document-sheet.tsx:176` — `item.total` only. Base invisible.
- `builder/items-list.tsx:262` — `item.total` only. Base invisible.

The same three-part idea is expressed once correctly and twice not at all. That
is the bug.

### B2. Shape

`toSheetData` in `src/lib/sheet-data.ts` already carries every number needed. It
gains an explicit per-item breakdown so consumers stop deriving it:

```ts
type ItemBreakdown = {
  qty: number;          // always 1 today; rendered, never multiplied
  basePrice: string;    // the machine on its own
  options: Array<{ name: string; qty: number; lineTotal: string | null }>;
  discount: {
    mode: "PERCENT" | "AMOUNT";
    value: string;      // what the salesperson typed: 5 (%) or 20000 ($)
    amount: string;     // the cash actually deducted, always resolved
  } | null;
  subtotal: string;     // base + options - discount
};
```

`lineTotal` is `null` when option prices are hidden, so the presenter never has
to know about display flags.

Money arithmetic stays in `src/lib/pricing.ts` — it is the single source of
truth for cents and is not touched by this work.

### B3. Presenter

One component, `src/components/sheet/item-breakdown.tsx`, renders an
`ItemBreakdown`. Used by `quotation-sheet.tsx`, `document-sheet.tsx`, and (in a
compact variant) `builder/items-list.tsx`. Fixing a rendering rule now means
editing one file.

Rules:

- Base price row always renders, labelled with the product code and `Qty 1`.
- Option rows render when `showOptionPrices` is on, each with its own price.
- The subtotal row renders whenever the item has options, whether or not option
  prices are shown — this is what lets a salesperson hide option pricing and
  still show an honest per-machine figure.
- With `showItemPrices` and `showOptionPrices` both off, the item renders with
  no money at all; the document total is still shown, as it is today.

`document-sheet.tsx` currently ignores both display flags. After this change it
honours them, so a summary sheet and a full quotation agree about what is
visible.

### B4. Placeholder

`{{basePrice}}` is added to the description-template substitution in
`quotation-data.ts` alongside the existing `{{price}}`. `{{price}}` keeps its
current meaning (the combined subtotal) so existing catalogue templates keep
working.

---

## Part C — extra lines: negative amounts and photos

### C1. Negative amounts

`customLineSchema` in `src/lib/validation/documents.ts:53-66` rejects a negative
`unitPrice` via `NON_NEGATIVE_AMOUNT_REGEX`. A trade-in is the reason to allow
one: the meeting settled on writing `Trade-in K5 390, serial ..., customer
responsible for removal` as a line with a negative amount, rather than inventing
a trade-in record type.

- Custom document-level lines (`kind: CUSTOM`, `itemId: null`) accept a leading
  minus, at most 2 decimal places.
- Option and product lines keep the non-negative rule — a negative option is a
  data error, not a discount.
- `computeTotals` gains a guard: if the document subtotal computes below zero,
  the action fails with a clear message rather than producing a negative invoice
  total.
- The sheet renders negative extra lines with an explicit minus and distinct
  styling so they cannot be misread as a charge.

### C2. Photos on extra lines

`DocumentLine` already has `showImage` but no image source of its own — options
inherit theirs from the catalogue. A custom line has no catalogue entry, so it
needs its own column.

- Migration `z11_document_line_image` adds `DocumentLine.imageUrl String?`, kept
  separate from the destructive invoice migration (see Rollout).
- The extra-line editor gets an upload control and reuses the existing product
  image rendering, so a trade-in, a bought-in bundling table, or a one-off item
  looks like any other line. One mechanism, many uses.

### C3. Upload permission (security)

`POST /api/uploads` (`src/app/api/uploads/route.ts:19`) is ADMIN-only today.
Salespeople need it for their own quote lines.

`src/lib/uploads.ts` already validates well: declared MIME against an allow-list,
magic-byte sniffing to catch a relabelled payload, 5 MB cap, UUID filenames. The
one weak spot for a non-admin uploader is SVG — it is XML, it can carry script,
and it is accepted for catalogue vector art.

The route gains a `purpose` parameter:

| purpose | Role | Accepted types |
|---|---|---|
| `catalog` | ADMIN | jpg, png, webp, svg |
| `document-line` | ADMIN, MANAGER | jpg, png, webp |

`saveUpload` takes the allowed-type set as an argument instead of reading the
module-level constant, so the restriction is enforced in the same place the
sniffing happens and cannot be bypassed by a crafted `Content-Type`.

A MANAGER may only attach an uploaded image to a line on a document they can
already edit; the existing document authorisation covers this and is not
changed.

---

## Part D — quote validity

`Document.validityDays` exists but is written only at finalize time
(`finalize.ts:85-88`) from the org-wide `quote.validityDays` setting, so a
salesperson cannot give one customer a longer window. John's CAPEX scenario
(*"How long does that normally take? Six weeks. Okay, I'll give you eight"*)
needs it per quote.

- The builder gets a `Valid for N days` field, defaulting to the org setting,
  editable while the document is a DRAFT.
- Finalize uses the document's own value when set, falling back to the setting.
- Over 30 days shows an inline warning. It does not block: the cap is a sales
  guideline, not a rule, and the discount cap already covers the case where
  money is actually at risk.
- The sheet prints `Valid until: <date>` inside the Total Investment block, not
  only in the header — the meeting was explicit that the expiry should sit next
  to the price it applies to.

## Part E — PDF page numbers

`src/lib/pdf.ts` gains a footer template passed to Gotenberg: quote number on
the left, `Page X of Y` on the right. Applied in `pdf.ts` itself so both PDF
routes (summary and full quotation) inherit it.

---

## Part F — percentage or fixed-amount discounts

### F1. Problem

Both discount fields are percentage-only: `Document.discountPct` and
`DocumentItem.discountPct`, enforced by `discountPctSchema`
(`validation/documents.ts:81-95`) and applied in `pricing.ts:216-231`. A
salesperson who has agreed "twenty grand off" has to compute the equivalent
percentage and accept the rounding, or push it into an extra line where it is
not a discount at all.

### F2. Model

Each discount becomes a mode plus a value, replacing the bare percentage:

```prisma
enum DiscountMode { PERCENT AMOUNT }

// on both Document and DocumentItem
discountMode  DiscountMode @default(PERCENT)
discountValue Decimal?     @db.Decimal(12, 2)
```

Migration `z12_discount_mode` renames `discountPct` to `discountValue`, widens it
from `Decimal(5,2)` to `Decimal(12,2)`, and adds `discountMode` defaulting to
`PERCENT`. Every existing row is a percentage, so the default is correct and no
data conversion is needed.

Storing a mode rather than two nullable columns (`discountPct` and
`discountAmount`) means the invalid state — both set, disagreeing — cannot be
represented.

### F3. Pricing

`computeTotals` resolves each discount to a cash amount before subtracting:

- `PERCENT`: `amount = round(base * value / 100)`, matching today's behaviour.
- `AMOUNT`: `amount = toCents(value)`, capped at `base` so a discount can never
  exceed what it applies to.

Rounding stays where it is now — cents, integer arithmetic, no floats.

### F4. Discount cap

`Region.maxDiscountPct` is a percentage, and it must keep working for cash
discounts or the cap becomes trivially avoidable — "10% max" means nothing if
the same salesperson can type an unlimited dollar figure.

For an `AMOUNT` discount, the effective percentage is
`amount / base * 100`, checked against the same cap with the same roles:
MANAGER is rejected over the cap, ADMIN gets a warning and the save proceeds
(`actions/documents.ts:668-678`, `:744-753`). The rejection message states both
figures: the cash amount and the percentage it works out to.

Because the cap is relative to the base, an amount discount must be re-validated
whenever the item's base or options change — otherwise removing an option could
silently push a fixed discount over the cap. `recalcDocument` performs this
check and surfaces a violation the same way an over-cap percentage does today.

### F5. UI

The discount field gains a mode toggle beside the number input: `%` and the
region's currency symbol. Switching mode clears the value rather than converting
it — a converted number invites the salesperson to accept a figure they did not
choose. Present on both the item discount field
(`components/builder/item-discount-field.tsx`) and the document one
(`components/builder/document-discount-field.tsx`).

The sheets print `Discount 5%` or `Discount −$20,000.00` from the resolved
breakdown, so a reader always sees the cash effect regardless of how it was
entered.

---

## Part G — Region becomes Distributor, with several bank accounts

### G1. Why

`Region` conflates two things: a geography and a selling entity. The business
has two selling entities in the same geography — Pathfinder LLC and David Cook,
a reseller — each with its own address, logo, discount cap, price list, and bank
accounts. A model keyed on "region" cannot express that.

The name is already drifting in the codebase's favour: the production order
forms spec calls `Region.entityName` "the distributor" in five places.

Geography does not disappear; it stops being the primary key of the concept. A
distributor gains a `country` (ISO alpha-2), so distributors can be grouped and
displayed by where they sell.

### G2. Rename

`Region` → `Distributor` across schema, code, routes, and UI:

| Before | After |
|---|---|
| `model Region` | `model Distributor` |
| `Document.regionId`, `Company.regionId`, `User.regionId`, `Price.regionId`, `ContentBlock.regionId` | `distributorId` |
| `NumberSequence.regionCode` | `distributorCode` |
| `@@unique([productId, regionId])` / `([optionId, regionId])` | `([productId, distributorId])` / `([optionId, distributorId])` |
| `/settings/regions`, `[regionId]` | `/settings/distributors`, `[distributorId]` |
| `src/lib/{queries,actions,validation}/regions.ts` | `distributors.ts` |
| `tests/regions-validation.test.ts` | `tests/distributors-validation.test.ts` |
| session/JWT `regionId` (`src/types/next-auth.d.ts`) | `distributorId` |

The migration uses explicit `ALTER TABLE ... RENAME` statements rather than
letting Prisma diff the models — a diff would drop and recreate the tables,
which works only because there is no production data yet and would still wipe
every developer's local database for no reason.

Constraint and index names are renamed alongside their objects so the schema
does not carry `Region_*` names on `Distributor_*` objects.

`NumberSequence.distributorCode` has no foreign key — it stores a copy of the
code — so renaming the table does not touch it. It is renamed separately, along
with the compound-key name `distributorCode_year` in `src/lib/numbering.ts`.

**Not renamed** — these are true geography or unrelated vocabulary:
`Company.country`, `Company.deliveryCountry`, `src/lib/countries.ts`,
`country-select.tsx`, libphonenumber's `defaultRegion` in `src/lib/phone.ts`,
`role="region"` in `toast.tsx`, and "edit region" in `markdown-editor.ts`.

`src/app/api/health/route.ts:28` deliberately probes
`db.region.findFirst({ select: { maxDiscountPct } })` to catch schema drift. It
must be updated in the same commit or the health check fails on deploy.

### G3. Distributor codes

Codes are currently `AU` / `US` / `UK` and `regionCodeSchema` enforces that
shape. Two distributors in one country need distinguishable codes, so the schema
relaxes to `^[A-Z0-9][A-Z0-9-]{1,7}$` — for example `AU`, `US-LLC`, `DCOOK`.

Codes appear in document numbers, so `Q-US-LLC-2026-001` is a legal number.
`formatDocNumber` does not need to parse the number back, so the extra hyphen is
harmless.

Four near-duplicate code schemas exist today (`validation/regions.ts:15`,
`validation/content.ts:60`, `validation/clients.ts:116`, inline in
`validation/catalog.ts:133`, plus a nullable variant in `validation/users.ts:56`).
They collapse into one exported schema during the rename, since editing five
copies of the same regex to the same new pattern is how they drifted in the
first place.

### G4. Bank accounts

`Region.bankDetails` is a single `Json?` column holding one flat label→value
map. It becomes a child table:

```prisma
model DistributorBankAccount {
  id            String      @id @default(cuid())
  distributorId String
  distributor   Distributor @relation(fields: [distributorId], references: [id], onDelete: Cascade)
  label         String      // "LLC operating account", "David Cook — Chase"
  details       Json        // same label -> value map as today
  currency      String?     // informational; the document's currency still governs
  isDefault     Boolean     @default(false)
  sortOrder     Int         @default(0)

  @@index([distributorId])
}
```

`details` keeps the existing shape, so `BANK_LABELS`, `humanizeBankKey`,
`toBankRows`, and `formatBankDetails` in `sheet-data.ts` keep working unchanged
— only their input changes from "the region's blob" to "the selected account's
blob".

`Document` gains `bankAccountId String?`. When null, the distributor's default
account is used. The builder shows the selector only when the distributor has
more than one account, so the common case gains no clicks.

Editing bank accounts stays ADMIN-only, matching today's region permissions.
This is the control that keeps payment details out of a salesperson's hands, and
it is the reason the meeting asked for the feature at all.

### G5. Snapshot

`finalize.ts:89-99` freezes the entity into `Document.entitySnapshot`, including
`bankDetails` and `regionCode`. The frozen shape changes to carry the selected
account (`bankAccountLabel` + `bankDetails`) and `distributorCode`.

No back-compat reader is written: there are no finalized documents yet, in
production or anywhere else — confirmed by the owner. `parseEntitySnapshot` in
`sheet-data.ts:266-296` validates the new shape only, and rejects anything else
as it does today.

---

## Testing

Baseline before any change: 752 tests across 28 files, all passing.

**Deleted:** `tests/invoice-from-quote.test.ts`.

**Edited to drop invoice cases:** `tests/sheet-data.test.ts` (invoice fixtures,
`title === "INVOICE"`, `showSignature === false`), `tests/numbering.test.ts`
(`INV` prefix), `tests/pdf.test.ts` (`INV-AU-2026-001` fixture),
`tests/documents-validation.test.ts` ("accepts INVOICE").

**New:**

- `item-breakdown`: base price present; subtotal present when the item has
  options; option prices hidden but subtotal shown when `showOptionPrices` is
  off; nothing priced when both flags are off.
- `sheet-data`: `ItemBreakdown` matches `computeTotals` to the cent for an item
  with options and an item discount.
- validation: negative custom line accepted; negative option line rejected;
  document subtotal below zero rejected.
- `validityDays`: builder value wins over the org setting at finalize; falls back
  when unset; `validUntil` equals issue date plus days.
- uploads: SVG rejected for `purpose=document-line`; accepted for
  `purpose=catalog` as ADMIN; `document-line` rejected for a non-authenticated
  caller.
- numbering: sequence allocation is per `(region, year)` after `docType` is gone.
- distributor codes: `US-LLC` accepted, `us-llc` rejected, over-length rejected;
  one shared schema is used by companies, users, content, catalog prices.
- numbering: `Q-US-LLC-2026-001` formats correctly; two distributors in the same
  country keep independent counters.
- bank accounts: the default account is used when the document selects none;
  an explicitly selected account wins; the finalize snapshot carries the
  selected account's label and details.
- discounts: percentage behaviour unchanged to the cent; an amount discount
  deducts exactly what was typed; an amount larger than the base is capped at
  the base; an amount over `Region.maxDiscountPct` is rejected for MANAGER and
  warned for ADMIN; removing an option re-validates a fixed discount against the
  smaller base.

Test-driven per `superpowers:test-driven-development` — each behaviour gets a
failing test before the code that satisfies it.

---

## Rollout

1. Work in `.worktrees/p0` on `feat/p0-quote-correctness`.
2. Land in this order: invoice removal (code, then migration), then the discount
   model, then the shared presenter, then extra lines, then validity, then the
   PDF footer. Removal first because it deletes branches the presenter would
   otherwise have to preserve; the discount model before the presenter because
   the presenter renders the resolved discount.
3. Five migrations, kept separate so a failure in one does not roll back the
   others: `z10_remove_invoices`, `z11_document_line_image`, `z12_discount_mode`,
   `13_distributor_rename`, `14_distributor_bank_accounts`.
4. Merge to `main` in two pull requests, not one: first invoice removal plus
   Parts B–F, then the distributor rename plus bank accounts. Both touch code
   the order-forms branch also edits, and two rebases against two focused
   changes is less error-prone than one rebase against a diff that both deletes
   a document type and renames a core model.
5. The order-forms branch rebases after each. It drops its own invoice handling
   in the first rebase and picks up the `distributorId` naming in the second.

## Risks

**The order-forms branch carries about 105 invoice references** in its own copy
of `src` and the schema. Its rebase will be real work. Mitigated by merging this
first — rebasing onto a world without invoices is mechanical deletion, whereas
merging invoice removal into finished order-forms code means re-reviewing that
feature's assumptions.

**The migrations destroy data.** Invoices are deleted and the entity snapshot
format changes without a back-compat reader. Both are safe because there are no
real quotes or invoices anywhere yet — confirmed by the owner. This assumption
expires the moment a salesperson issues a real quote, so these migrations must
land before the tool is used in the field.

**The rename is wide.** It touches five foreign keys, the `Price` compound keys,
the NextAuth session and JWT payload, the document-number format, and the health
check's drift probe. A partial rename leaves the app compiling but broken at
runtime — particularly `src/app/api/health/route.ts`, which fails on deploy, and
existing sessions, whose JWT still carries `regionId`. Sessions are invalidated
as part of the rollout rather than reading both field names.

**`document-sheet.tsx` starts honouring display flags** it currently ignores. A
saved quote whose flags are off will render less money on the summary sheet than
it did before. This is the intended behaviour — the flags are supposed to control
that sheet too — but it is a visible change to existing documents.
