# Tax & Incoterms per Quote — Design

Date: 2026-09-30
Status: Pending review

## Problem

Tax today is a single figure per region: `Region.taxName`/`taxRate`, copied onto
the `Document` at `createDraft`, refreshed while the document is a DRAFT and
frozen at finalize (`src/lib/documents/tax.ts`). The only per-quote lever is
`DeliveryTerms` (`DELIVERED` | `EX_WORKS`), and `EX_WORKS` unconditionally
zeroes the tax.

The tax a seller must charge depends on three facts: who sells (the region's
legal entity), where the goods go (the destination country), and the delivery
terms. Only the first is modelled, so:

- an Australian quote delivered to New Zealand or Mexico charges GST 10%, but an
  export is GST-free;
- an Australian customer collecting Ex Works is charged 0%, but a domestic sale
  carries GST 10% whatever the delivery terms (confirmed by Vadym, 2026-09-30);
- a US distributor selling into Canada, or a UK distributor selling into the EU,
  gets its home rate;
- US sales tax varies by state and city, so no single region rate is right.

## Decisions (Vadym, 2026-09-30)

- Tax is decided **per quote**, never stored on the client. The same client may
  buy EXW one time and DDP the next. Knowing where and to whom they sell is the
  salesperson's responsibility; the app suggests.
- Two modes: **Auto**, where the app suggests, and **Custom**, where the
  salesperson types the tax name, rate and a reason.
- Custom is free for any user who can edit the quote, but a reason is required,
  and the override is visible to the author, Regional manager, Admin and
  Developer.
- Incoterms are limited to what Pathfinder actually uses: **EXW, DAP, DDP,
  FOB**. Add more only when asked.
- No admin-maintained rule tables. The rules live in code.
- UI lives on the Quote setup tab, replacing the "Delivery terms" card.

## Data model

### Region

- `country String`: ISO 3166-1 alpha-2 code of the selling entity (AU, US, GB,
  DE, SE, LT, PT, IN). Required in the region form. `taxName`/`taxRate` stay:
  they are the region's **standard domestic** rate.

### Enums

```prisma
enum Incoterm { EXW DAP DDP FOB }           // replaces DeliveryTerms
enum TaxTreatment { STANDARD EXPORT REVERSE_CHARGE CUSTOM }
```

`DeliveryTerms` is removed.

### Document

| Column | Type | Meaning |
|---|---|---|
| `incoterm` | `Incoterm @default(DAP)` | replaces `deliveryTerms` |
| `taxTreatment` | `TaxTreatment @default(STANDARD)` | resolved treatment, drives printing |
| `taxName` | `String` (exists) | **effective** label |
| `taxRate` | `Decimal(5,2)` (exists) | **effective** rate: 0 for EXPORT/REVERSE_CHARGE |
| `taxOverridden` | `Boolean @default(false)` | true = Custom mode |
| `taxNote` | `String?` | reason for Custom; internal, never printed |

`taxRate` changes meaning from "region nominal rate" to "rate actually
charged". `engineTaxRate` goes away: the pricing engine is fed `taxRate`.

**Destination country** is derived, not stored on the document:
`company.deliverySameAsMain ? company.country : company.deliveryCountry`.

## Suggestion rules

A pure, dependency-free function in `src/lib/documents/tax.ts`:

```ts
suggestTax({ sellerCountry, destinationCountry, incoterm, regionTax })
  → { treatment, taxName, taxRate, reason, blocker? }
```

Evaluated in order:

1. **No destination country** → STANDARD at the region rate. Blocker:
   "Set client's delivery country".
2. **Destination = seller country** → STANDARD at the region rate, **for every
   incoterm including EXW**. If the region rate is 0 (US), add the hint "US tax
   depends on state/city. Choose Custom if needed." (a hint, not a blocker).
3. **Destination ≠ seller, incoterm DDP** → no suggestion. Blocker: "DDP abroad:
   set the destination country's tax (Custom)". The provisional figures are
   STANDARD at the region rate so totals still render.
4. **Destination ≠ seller, both in the EU** → REVERSE_CHARGE, 0%, label = the
   region's `taxName` (VAT). Blocker if the client has no `taxId`: "Add client's
   VAT ID".
5. **Destination ≠ seller, otherwise** → EXPORT, 0%, label = the region's
   `taxName`.

EU membership is a constant list of ISO codes in code. GB is not in it, so
UK→EU is an export.

`reason` is a one-line human explanation shown under the Auto choice, e.g.
"Goods leave Australia → export, no GST".

## Resolution and lifecycle

`resolveDocumentTax` (extended, still pure) decides what the document carries:

| State | Result |
|---|---|
| FINAL (anything not DRAFT) | Frozen. Row values returned unchanged, `refresh = null`. |
| DRAFT, `taxOverridden = false` | Fresh `suggestTax` result. Written back when it differs. |
| DRAFT, `taxOverridden = true` | Row values (CUSTOM, name, rate) kept. Never overwritten. |

`recalcDocument` is still the single caller. It loads the region's `country`
and the company's countries and `taxId` beside what it already loads.

### Finalize blockers

Added to the finalize readiness check, the same way the region discount limit
blocks finalize while still allowing save:

- Auto with a blocker (rules 1, 3, 4).
- Custom without a name, rate or reason.

## Actions

- `setIncoterm(documentId, formData)` replaces `setDeliveryTerms`: validates
  against `incotermSchema = z.enum(["EXW","DAP","DDP","FOB"])`, then recalc.
- `setDocumentTax(documentId, formData)`: `mode = AUTO | CUSTOM`. For CUSTOM,
  `taxName` (1–40 chars), `taxRate` (0–100, 2 dp), `taxNote` (1–200 chars).
  AUTO clears `taxOverridden`/`taxNote` and recalcs. Same permission as other
  builder edits on a DRAFT (author, or Regional manager in region, Admin,
  Developer).

## UI — Quote setup tab

The "Delivery terms" `SectionCard` becomes **"Delivery & tax"**
(`src/components/builder/delivery-tax-field.tsx` replaces
`delivery-terms-field.tsx`). Autosave via `useAutosave`, like its neighbours.

```
┌ Delivery & tax ─────────────────────────────────────┐
│ Incoterm   [ DAP — Delivered at Place        ▾]     │
│ Route      Australia → Canada   (from client)       │
│                                                     │
│ Tax        (•) Auto   Export — no GST (0%)          │
│                ⓘ Goods leave Australia → export     │
│            ( ) Custom                               │
│                Name [Sales Tax (Texas)]  Rate [8.25]%│
│                Reason* [Delivered to Austin, TX   ] │
│                ⚠ Differs from suggestion: Export 0% │
└─────────────────────────────────────────────────────┘
```

- Incoterm options: `EXW — Ex Works`, `DAP — Delivered at Place`,
  `DDP — Delivered Duty Paid`, `FOB — Free on Board`.
- Route shows seller country → destination country. When the destination is
  missing, it links to the Client step.
- Custom fields are shown only when Custom is selected. Switching back to Auto
  discards the custom values.
- Blockers render as warnings inside the card. The VAT ID warning links to the
  Client step.
- Read-only (FINAL) renders one line, e.g. `DAP · GST 10%` or
  `FOB · Export, no GST`.

**Override visibility:** on the quote page, a "Tax: custom" badge next to the
total, with `taxNote` in a tooltip. Shown to the author, Regional manager,
Admin and Developer. No reports.

**Region form** (`/settings/regions`): new required Country select using the
existing country picker (`src/lib/countries.ts`).

## Printing — quotation sheet

`sheet-data.ts` carries `incoterm`, `taxTreatment`, `taxName`, `taxRate` and
the client's `taxId` instead of `deliveryTerms`.

| Treatment | Total banner note | Tax row in totals | Extra note |
|---|---|---|---|
| STANDARD, rate > 0 | `(DAP, incl. GST 10%)` | `GST 10%  $x` | — |
| STANDARD, rate 0 | `(DAP)` | none | — |
| EXPORT | `(FOB, export — no GST)` | none | — |
| REVERSE_CHARGE | `(DAP, VAT reverse charge)` | none | "Reverse charge: VAT to be accounted for by the recipient. Customer VAT ID: {taxId}" under the totals |
| CUSTOM, rate > 0 | `(DDP, incl. Sales Tax (Texas) 8.25%)` | `Sales Tax (Texas) 8.25%  $x` | — |
| CUSTOM, rate 0 | `(EXW, {taxName})`, e.g. "Tax exempt" | none | — |

`taxNote` is never printed. The signing page uses the same sheet, so it follows.

## Migration (production is live)

One Prisma migration, no row deletions:

1. Add `Region.country`, backfilled `AU→AU`, `US→US`, `UK→GB`, other codes
   mapped 1:1 where they are ISO codes. Then `NOT NULL`. Admin checks
   Settings → Regions after deploy.
2. Create `Incoterm`, add `Document.incoterm`: `DELIVERED→DAP`,
   `EX_WORKS→EXW`. Drop `deliveryTerms` and the `DeliveryTerms` enum.
3. Add `taxTreatment`, `taxOverridden`, `taxNote`. Former `EX_WORKS` rows get
   `taxTreatment = EXPORT, taxRate = 0`. Their `taxAmount` is already 0, so
   totals of finalized quotes do not change. All others get STANDARD.
4. Rewrite `deliveryTerms` inside stored revision-snapshot JSON the same way
   (`DELIVERED→DAP`, `EX_WORKS→EXW`, key renamed to `incoterm`), so old
   revisions read without legacy code paths.
5. Drafts pick up the new rules on their next recalc. Before deploying, list
   the drafts whose totals will change (e.g. Australian EXW drafts) and show
   them to Vadym.
6. Take a manual database backup immediately before running the migration.

## Removed

`DeliveryTerms` enum, `deliveryTermsSchema`, `setDeliveryTerms`,
`DeliveryTermsField`, `engineTaxRate`, every `=== "EX_WORKS"` branch in the
sheet. No compatibility shims.

## Testing

Unit, pure (`tests/`, no DB):

- `suggestTax` matrix: AU→AU EXW = STANDARD GST 10%; AU→AU DAP = STANDARD;
  AU→NZ FOB = EXPORT 0%; AU→MX EXW = EXPORT; LT→DE DAP = REVERSE_CHARGE;
  LT→DE without VAT ID = blocker; GB→DE = EXPORT; US→US = STANDARD 0% + hint;
  US→CA DAP = EXPORT; any→abroad DDP = blocker; missing destination = blocker.
- `resolveDocumentTax`: FINAL frozen; DRAFT auto refreshes; DRAFT overridden
  never overwritten; no-op when unchanged ("10" vs "10.00").
- Validation: custom requires name, rate 0–100, reason.
- Finalize readiness: each blocker blocks finalize but not save.
- Sheet rendering: one snapshot per treatment row in the printing table.

## Out of scope

- Per-state US tax tables and automatic sales-tax lookup.
- Storing tax preferences on the client.
- Named place after the incoterm ("FOB Melbourne").
- Incoterms beyond EXW/DAP/DDP/FOB.
- Reports on tax overrides.
