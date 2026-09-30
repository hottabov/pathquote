# Tax & Incoterms per Quote — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Every quote carries an Incoterm (EXW/DAP/DDP/FOB) and a tax that the app suggests from seller country + destination country + Incoterm, which the salesperson can replace with a Custom tax (name, rate, reason).

**Architecture:** Two new pure modules: `tax-rules.ts` (suggestion) and `tax-print.ts` (what the sheet prints). The existing pure `resolveDocumentTax` in `tax.ts` is rewritten to choose between suggestion, override and freeze. `recalcDocument` stays the single place that persists a document's tax. It now also reports a `taxBlocker`, which finalize enforces and the readiness panel shows. `DeliveryTerms` is replaced by an `Incoterm` enum; `Region` gains `country`.

**Tech Stack:** Next.js 16 (read `node_modules/next/dist/docs/` before touching routing/server-action APIs), Prisma 7 + Postgres, zod 4, vitest 4, React server/client components.

**Spec:** `docs/superpowers/specs/2026-09-30-tax-and-incoterms-design.md`

---

## Ground rules for this repo

- Production is live (see `AGENTS.md`). The migration in Task 5 touches `Document` rows. Vadym approved it in the spec **on condition of a manual DB backup first** (Task 14).
- `npx prisma generate` fails inside the Cowork sandbox (`EPERM ... unlink`). After Task 5, `npx tsc --noEmit` will report errors for the new columns until Vadym regenerates on his Mac. Verify with `npx vitest run` and `npx eslint`. For `tsc`, only check that no *other* error class appears. Write its output to a file: it takes 90–150 s.
- No backward-compat shims: old names are deleted, not aliased (`preferences.md`).
- Tests import pure modules only (no `@/lib/db`). Test files live in `tests/*.test.ts` and use `@/` imports.
- Run one test file: `npx vitest run tests/<file>.test.ts`. Run all: `npx vitest run`.
- Commit after each task. End every commit message with:

```
Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01B9dKxSqj4mFm5rwzUM2vj1
```

## File map

| File | Change | Responsibility |
|---|---|---|
| `src/lib/documents/tax-rules.ts` | create | Incoterm list/labels, EU list, `destinationCountry`, `suggestTax` |
| `src/lib/documents/tax.ts` | rewrite | `resolveDocumentTax`: freeze / override / suggestion + blocker |
| `src/lib/documents/tax-print.ts` | create | banner note, tax-row visibility/label, reverse-charge note |
| `src/lib/validation/documents.ts` | modify | `incotermSchema`, `documentTaxSchema`; delete `deliveryTermsSchema` |
| `src/lib/validation/regions.ts` | modify | `regionCountrySchema` in the region form fields |
| `prisma/schema.prisma` | modify | `Region.country`, `Incoterm`, `TaxTreatment`, Document columns; drop `DeliveryTerms` |
| `prisma/migrations/z59_tax_incoterms/migration.sql` | create | schema + data migration |
| `scripts/sql/tax-migration-preview.sql` | create | read-only list of drafts whose tax will change |
| `prisma/seed-lib.ts`, `prisma/seed.ts` | modify | region `country` |
| `src/lib/documents/recalc.ts` | modify | feed suggestion, persist treatment, return `taxBlocker` |
| `src/lib/actions/finalize.ts` | modify | refuse on `taxBlocker`; snapshot input |
| `src/lib/actions/documents/presentation.ts` | modify | `setIncoterm`, `setDocumentTax`; delete `setDeliveryTerms` |
| `src/lib/actions/documents.ts` | modify | re-exports |
| `src/lib/documents/revision-snapshot.ts` | modify | v2: `incoterm` + `taxTreatment` replace `deliveryTerms` |
| `src/lib/sheet-data.ts` | modify | carry `incoterm`, `taxTreatment`, `customerTaxId` |
| `src/lib/queries/documents-builder.ts` | modify | builder fields + suggestion/blocker |
| `src/lib/queries/signing.ts` | modify | same fields for the signing page |
| `src/components/sheet/sections/total-banner.tsx` | modify | banner note via `tax-print` |
| `src/components/sheet/sections/investment-summary.tsx` | modify | tax row + reverse-charge note via `tax-print` |
| `src/components/builder/delivery-tax-field.tsx` | create | "Delivery & tax" card body |
| `src/components/builder/delivery-terms-field.tsx` | delete | replaced |
| `src/app/(app)/quotes/[documentId]/page.tsx` | modify | card swap, readiness input, totals badge |
| `src/components/builder/sticky-footer.tsx` | modify | "custom" badge beside the tax line |
| `src/lib/quote-readiness.ts` | modify | `tax` row |
| `src/lib/actions/regions.ts`, `src/components/regions/region-form.tsx`, `src/app/(app)/settings/regions/new/page.tsx`, `src/app/(app)/settings/regions/[regionId]/page.tsx` | modify | region country field |
| tests | modify/create | see each task |

---

### Task 1: Tax suggestion rules (pure)

**Files:**
- Create: `src/lib/documents/tax-rules.ts`
- Test: `tests/tax-rules.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/tax-rules.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { destinationCountry, suggestTax, type SuggestTaxInput } from "@/lib/documents/tax-rules";

const au: SuggestTaxInput = {
  sellerCountry: "AU",
  destinationCountry: "AU",
  incoterm: "DAP",
  regionTax: { taxName: "GST", taxRate: "10.00" },
  customerTaxId: null,
};

describe("suggestTax — domestic sale", () => {
  it("charges the region rate on a delivered domestic sale", () => {
    const s = suggestTax(au);
    expect(s).toMatchObject({ treatment: "STANDARD", taxName: "GST", taxRate: "10.00", blocker: null, hint: null });
  });

  it("charges GST on a domestic EXW sale too — the goods never leave Australia", () => {
    expect(suggestTax({ ...au, incoterm: "EXW" })).toMatchObject({ treatment: "STANDARD", taxRate: "10.00" });
  });

  it("charges the region rate on domestic DDP (nothing is imported)", () => {
    expect(suggestTax({ ...au, incoterm: "DDP" })).toMatchObject({ treatment: "STANDARD", blocker: null });
  });

  it("hints that a 0% domestic rate may need a Custom tax (US sales tax)", () => {
    const s = suggestTax({
      ...au,
      sellerCountry: "US",
      destinationCountry: "US",
      regionTax: { taxName: "Sales Tax", taxRate: "0.00" },
    });
    expect(s.treatment).toBe("STANDARD");
    expect(s.taxRate).toBe("0.00");
    expect(s.hint).toMatch(/Custom/);
    expect(s.blocker).toBeNull();
  });
});

describe("suggestTax — export", () => {
  it("zero-rates FOB to New Zealand", () => {
    expect(suggestTax({ ...au, destinationCountry: "NZ", incoterm: "FOB" })).toMatchObject({
      treatment: "EXPORT",
      taxName: "GST",
      taxRate: "0.00",
      blocker: null,
    });
  });

  it("zero-rates EXW to a foreign buyer", () => {
    expect(suggestTax({ ...au, destinationCountry: "MX", incoterm: "EXW" }).treatment).toBe("EXPORT");
  });

  it("zero-rates US → Canada", () => {
    const s = suggestTax({
      ...au,
      sellerCountry: "US",
      destinationCountry: "CA",
      regionTax: { taxName: "Sales Tax", taxRate: "0.00" },
    });
    expect(s.treatment).toBe("EXPORT");
  });

  it("treats UK → Germany as an export (GB is not in the EU)", () => {
    const s = suggestTax({
      ...au,
      sellerCountry: "GB",
      destinationCountry: "DE",
      regionTax: { taxName: "VAT", taxRate: "20.00" },
      customerTaxId: "DE123456789",
    });
    expect(s.treatment).toBe("EXPORT");
  });

  it("explains the export in the reason line", () => {
    expect(suggestTax({ ...au, destinationCountry: "NZ" }).reason).toBe("Goods leave Australia → export, no GST");
  });
});

describe("suggestTax — EU to EU", () => {
  const lt: SuggestTaxInput = {
    sellerCountry: "LT",
    destinationCountry: "DE",
    incoterm: "DAP",
    regionTax: { taxName: "VAT", taxRate: "21.00" },
    customerTaxId: "DE123456789",
  };

  it("reverse-charges Lithuania → Germany", () => {
    expect(suggestTax(lt)).toMatchObject({ treatment: "REVERSE_CHARGE", taxName: "VAT", taxRate: "0.00", blocker: null });
  });

  it("blocks reverse charge until the client's VAT ID is set", () => {
    expect(suggestTax({ ...lt, customerTaxId: "  " }).blocker).toBe("Add the client's VAT ID for reverse charge");
  });
});

describe("suggestTax — cases the app cannot decide", () => {
  it("blocks DDP into another country and keeps the region figures provisionally", () => {
    const s = suggestTax({ ...au, destinationCountry: "CA", incoterm: "DDP" });
    expect(s.treatment).toBe("STANDARD");
    expect(s.taxRate).toBe("10.00");
    expect(s.blocker).toBe("DDP abroad: set Canada's tax with Custom");
  });

  it("blocks when the destination country is unknown", () => {
    const s = suggestTax({ ...au, destinationCountry: null });
    expect(s.treatment).toBe("STANDARD");
    expect(s.blocker).toBe("Set the client's delivery country");
  });
});

describe("destinationCountry", () => {
  it("uses the main country when delivery is the same address", () => {
    expect(destinationCountry({ country: "AU", deliverySameAsMain: true, deliveryCountry: "NZ" })).toBe("AU");
  });

  it("uses the delivery country when it differs", () => {
    expect(destinationCountry({ country: "AU", deliverySameAsMain: false, deliveryCountry: "NZ" })).toBe("NZ");
  });

  it("falls back to the main country when the delivery country is blank", () => {
    expect(destinationCountry({ country: "AU", deliverySameAsMain: false, deliveryCountry: "" })).toBe("AU");
  });

  it("normalises legacy free text", () => {
    expect(destinationCountry({ country: "Australia", deliverySameAsMain: true, deliveryCountry: null })).toBe("AU");
    expect(destinationCountry({ country: "UK", deliverySameAsMain: true, deliveryCountry: null })).toBe("GB");
  });

  it("is null with no company or no country", () => {
    expect(destinationCountry(null)).toBeNull();
    expect(destinationCountry({ country: null, deliverySameAsMain: true, deliveryCountry: null })).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/tax-rules.test.ts`
Expected: FAIL, `Failed to resolve import "@/lib/documents/tax-rules"`.

- [ ] **Step 3: Write the implementation**

Create `src/lib/documents/tax-rules.ts`:

```ts
/**
 * Which tax a quote should carry, suggested from three facts: the selling
 * region's country, the country the goods go to, and the Incoterm (Vadym,
 * 2026-09-30 — see docs/superpowers/specs/2026-09-30-tax-and-incoterms-design.md).
 *
 * It is a suggestion. The salesperson is responsible for knowing whom and
 * where they sell to, and can replace it with a Custom tax on the quote's
 * Setup tab. `blocker` names the cases the app cannot decide; a blocked
 * suggestion still carries provisional figures so totals keep rendering,
 * and finalize refuses until the salesperson resolves it.
 *
 * Pure: no Prisma, no React. `countries.ts` is itself dependency-free, so
 * this module is safe in the browser bundle and in plain vitest.
 */
import { countryName, normalizeCountryInput } from "@/lib/countries";

export const INCOTERMS = ["EXW", "DAP", "DDP", "FOB"] as const;
export type Incoterm = (typeof INCOTERMS)[number];

export const INCOTERM_LABELS: Record<Incoterm, string> = {
  EXW: "Ex Works",
  DAP: "Delivered at Place",
  DDP: "Delivered Duty Paid",
  FOB: "Free on Board",
};

export type TaxTreatment = "STANDARD" | "EXPORT" | "REVERSE_CHARGE" | "CUSTOM";

/** EU member states (ISO 3166-1 alpha-2). GB is deliberately absent. */
export const EU_COUNTRIES: ReadonlySet<string> = new Set([
  "AT", "BE", "BG", "HR", "CY", "CZ", "DK", "EE", "FI", "FR", "DE", "GR", "HU", "IE",
  "IT", "LV", "LT", "LU", "MT", "NL", "PL", "PT", "RO", "SK", "SI", "ES", "SE",
]);

export type SuggestTaxInput = {
  /** `Region.country`. */
  sellerCountry: string;
  /** See `destinationCountry` below. */
  destinationCountry: string | null;
  incoterm: Incoterm;
  /** The region's standard domestic tax. */
  regionTax: { taxName: string; taxRate: string };
  /** `Company.taxId` — the VAT ID reverse charge needs. */
  customerTaxId: string | null;
};

export type TaxSuggestion = {
  treatment: Exclude<TaxTreatment, "CUSTOM">;
  taxName: string;
  /** String, like the `Decimal(5,2)` columns it is written to. */
  taxRate: string;
  /** One line explaining the suggestion, shown under "Auto". */
  reason: string;
  /** Advice that never blocks (a 0% domestic rate). */
  hint: string | null;
  /** Why this quote cannot be finalized on Auto, or null. */
  blocker: string | null;
};

const ZERO = "0.00";

function label(code: string): string {
  return countryName(code) ?? code;
}

function rateText(rate: string): string {
  return String(Number(rate));
}

/**
 * Where the goods go: the delivery address's country when the company has a
 * separate one, else its main country. Legacy free-text countries are
 * normalised the same way the client form does it.
 */
export function destinationCountry(
  company: { country: string | null; deliverySameAsMain: boolean; deliveryCountry: string | null } | null
): string | null {
  if (!company) return null;
  const delivery = company.deliverySameAsMain ? null : normalizeCountryInput(company.deliveryCountry);
  return delivery ?? normalizeCountryInput(company.country);
}

export function suggestTax(input: SuggestTaxInput): TaxSuggestion {
  const { sellerCountry, destinationCountry: dest, incoterm, regionTax } = input;
  const seller = label(sellerCountry);
  const standard = { treatment: "STANDARD" as const, taxName: regionTax.taxName, taxRate: regionTax.taxRate };

  if (!dest) {
    return {
      ...standard,
      reason: "The client's delivery country is not set",
      hint: null,
      blocker: "Set the client's delivery country",
    };
  }

  if (dest === sellerCountry) {
    const zeroRate = Number(regionTax.taxRate) === 0;
    return {
      ...standard,
      reason: `Sale within ${seller} → ${regionTax.taxName} ${rateText(regionTax.taxRate)}%`,
      hint: zeroRate ? `Tax in ${seller} may depend on the state or city. Choose Custom if this sale is taxed.` : null,
      blocker: null,
    };
  }

  const destination = label(dest);

  if (incoterm === "DDP") {
    return {
      ...standard,
      reason: `DDP to ${destination}: you import the goods, so ${destination}'s tax applies`,
      hint: null,
      blocker: `DDP abroad: set ${destination}'s tax with Custom`,
    };
  }

  if (EU_COUNTRIES.has(sellerCountry) && EU_COUNTRIES.has(dest)) {
    return {
      treatment: "REVERSE_CHARGE",
      taxName: regionTax.taxName,
      taxRate: ZERO,
      reason: `EU sale ${seller} → ${destination}: the buyer accounts for ${regionTax.taxName}`,
      hint: null,
      blocker: input.customerTaxId?.trim() ? null : "Add the client's VAT ID for reverse charge",
    };
  }

  return {
    treatment: "EXPORT",
    taxName: regionTax.taxName,
    taxRate: ZERO,
    reason: `Goods leave ${seller} → export, no ${regionTax.taxName}`,
    hint: null,
    blocker: null,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/tax-rules.test.ts`
Expected: PASS (all tests). If `countryName("AU")` returns something other than "Australia", check `src/lib/country-names.ts` and fix the expected string in the reason test, not the code.

- [ ] **Step 5: Commit**

```bash
git add src/lib/documents/tax-rules.ts tests/tax-rules.test.ts
git commit -m "feat(tax): suggest a quote's tax from seller, destination and incoterm"
```

### Task 2: Rewrite `resolveDocumentTax` (freeze / override / suggestion)

**Files:**
- Rewrite: `src/lib/documents/tax.ts`
- Rewrite: `tests/document-tax.test.ts`

- [ ] **Step 1: Replace the test file**

Replace the whole of `tests/document-tax.test.ts` with:

```ts
import { describe, it, expect } from "vitest";
import { resolveDocumentTax, type ResolveTaxInput } from "@/lib/documents/tax";
import type { TaxSuggestion } from "@/lib/documents/tax-rules";
import { computeTotals } from "@/lib/pricing";

/**
 * The rule that decides which tax a quote carries: a FINAL document is
 * frozen, a Custom tax is never overwritten, and an Auto draft follows the
 * suggestion (src/lib/documents/tax-rules.ts). Both directions of the old
 * freeze/refresh bug stay pinned: a draft must pick up a region rate
 * configured after it was created, and an issued quote must never be
 * rewritten by a later region edit.
 */

const gst: TaxSuggestion = {
  treatment: "STANDARD",
  taxName: "GST",
  taxRate: "10.00",
  reason: "Sale within Australia → GST 10%",
  hint: null,
  blocker: null,
};

const exportSuggestion: TaxSuggestion = {
  treatment: "EXPORT",
  taxName: "GST",
  taxRate: "0.00",
  reason: "Goods leave Australia → export, no GST",
  hint: null,
  blocker: null,
};

const base: ResolveTaxInput = {
  status: "DRAFT",
  document: { taxTreatment: "STANDARD", taxName: "GST", taxRate: "10.00", taxOverridden: false, taxNote: null },
  suggestion: gst,
};

describe("resolveDocumentTax — an Auto draft follows the suggestion", () => {
  it("adopts a rate configured after the draft was created", () => {
    const tax = resolveDocumentTax({ ...base, document: { ...base.document, taxRate: "0.00" } });
    expect(tax.taxRate).toBe("10.00");
    expect(tax.refresh).toEqual({ taxTreatment: "STANDARD", taxName: "GST", taxRate: "10.00" });
  });

  it("switches treatment when the destination becomes foreign", () => {
    const tax = resolveDocumentTax({ ...base, suggestion: exportSuggestion });
    expect(tax.taxTreatment).toBe("EXPORT");
    expect(tax.taxRate).toBe("0.00");
    expect(tax.refresh).toEqual({ taxTreatment: "EXPORT", taxName: "GST", taxRate: "0.00" });
  });

  it("asks for no write when the row already agrees", () => {
    expect(resolveDocumentTax(base).refresh).toBeNull();
  });

  it("treats a differently-rendered Decimal as agreement", () => {
    const tax = resolveDocumentTax({ ...base, document: { ...base.document, taxRate: "10" } });
    expect(tax.refresh).toBeNull();
  });

  it("passes the suggestion's blocker through", () => {
    const tax = resolveDocumentTax({ ...base, suggestion: { ...gst, blocker: "DDP abroad: set Canada's tax with Custom" } });
    expect(tax.blocker).toBe("DDP abroad: set Canada's tax with Custom");
  });
});

describe("resolveDocumentTax — a Custom draft is the salesperson's", () => {
  const custom: ResolveTaxInput = {
    ...base,
    document: {
      taxTreatment: "CUSTOM",
      taxName: "Sales Tax (Texas)",
      taxRate: "8.25",
      taxOverridden: true,
      taxNote: "Delivered to Austin, TX",
    },
    suggestion: exportSuggestion,
  };

  it("keeps the custom figures whatever the suggestion says", () => {
    const tax = resolveDocumentTax(custom);
    expect(tax).toMatchObject({ taxTreatment: "CUSTOM", taxName: "Sales Tax (Texas)", taxRate: "8.25", refresh: null, blocker: null });
  });

  it("ignores the suggestion's blocker — Custom is how a blocker is resolved", () => {
    const tax = resolveDocumentTax({ ...custom, suggestion: { ...gst, blocker: "DDP abroad: set Canada's tax with Custom" } });
    expect(tax.blocker).toBeNull();
  });

  it("blocks a custom tax with no reason", () => {
    expect(resolveDocumentTax({ ...custom, document: { ...custom.document, taxNote: "  " } }).blocker).toBe(
      "Give a reason for the custom tax"
    );
    expect(resolveDocumentTax({ ...custom, document: { ...custom.document, taxNote: null } }).blocker).toBe(
      "Give a reason for the custom tax"
    );
  });
});

describe("resolveDocumentTax — a FINAL document is frozen", () => {
  it("keeps the rate it was issued with", () => {
    const tax = resolveDocumentTax({ ...base, status: "FINAL", suggestion: { ...gst, taxRate: "12.50" } });
    expect(tax.taxRate).toBe("10.00");
    expect(tax.refresh).toBeNull();
  });

  it("keeps an issued export quote at 0% even when the suggestion now says STANDARD", () => {
    const tax = resolveDocumentTax({
      ...base,
      status: "FINAL",
      document: { ...base.document, taxTreatment: "EXPORT", taxRate: "0.00" },
    });
    expect(tax.taxTreatment).toBe("EXPORT");
    expect(tax.taxRate).toBe("0.00");
  });

  it("never blocks — the document is already issued", () => {
    const tax = resolveDocumentTax({ ...base, status: "FINAL", suggestion: { ...gst, blocker: "x" } });
    expect(tax.blocker).toBeNull();
  });

  it("never proposes a write for an unrecognised status either", () => {
    const tax = resolveDocumentTax({ ...base, status: "SOMETHING_ADDED_LATER", suggestion: { ...gst, taxRate: "12.50" } });
    expect(tax.refresh).toBeNull();
  });
});

describe("the resolved rate reaches the engine as money", () => {
  const priceOf = (taxRate: string) =>
    computeTotals({ items: [{ unitPrice: 10000, lines: [] }], extraLines: [], documentDiscountValue: null, taxRate: Number(taxRate) });

  it("charges GST on a domestic quote", () => {
    const totals = priceOf(resolveDocumentTax(base).taxRate);
    expect(totals.taxAmount).toBe(1000);
    expect(totals.total).toBe(11000);
  });

  it("charges nothing on an export", () => {
    const totals = priceOf(resolveDocumentTax({ ...base, suggestion: exportSuggestion }).taxRate);
    expect(totals.taxAmount).toBe(0);
    expect(totals.total).toBe(10000);
  });

  it("charges a custom fractional rate", () => {
    const tax = resolveDocumentTax({
      ...base,
      document: { taxTreatment: "CUSTOM", taxName: "Sales Tax", taxRate: "8.25", taxOverridden: true, taxNote: "TX" },
    });
    expect(priceOf(tax.taxRate).taxAmount).toBe(825);
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `npx vitest run tests/document-tax.test.ts`
Expected: FAIL (the old `resolveDocumentTax` has no `suggestion` input, so assertions on `taxTreatment`/`blocker` fail).

- [ ] **Step 3: Replace `src/lib/documents/tax.ts`**

```ts
/**
 * Resolving a document's tax — the one decision about which rate a quote is
 * actually charged at. `recalcDocument` (./recalc.ts) is the only caller: it
 * builds the suggestion (./tax-rules.ts), calls this, feeds `taxRate` to the
 * pricing engine and persists `refresh` when it is non-null.
 *
 * Three rules, in order:
 *
 * 1. Freeze. A FINAL document is a quote a customer holds. Its tax is
 *    whatever it was when the number was allocated; no later region edit,
 *    client edit or rule change may rewrite it. Any status other than
 *    DRAFT is treated as frozen, so a status added later defaults to the
 *    conservative behaviour.
 * 2. Override. A draft whose salesperson chose Custom keeps their name and
 *    rate. It never blocks on the suggestion (Custom is how a blocked
 *    suggestion is resolved), only on a missing reason.
 * 3. Suggestion. An Auto draft carries the current suggestion: the row is a
 *    cache of it, refreshed on every recalc, and only becomes a snapshot at
 *    finalize.
 *
 * `taxRate` is the rate actually charged (0 on an export), not the region's
 * nominal rate. Pure: no Prisma, no `@/lib/db`.
 */
import type { TaxSuggestion, TaxTreatment } from "./tax-rules";

export type DocumentTaxRow = {
  taxTreatment: TaxTreatment;
  taxName: string;
  /** `Decimal(5,2)` rendered with `.toString()`. */
  taxRate: string;
  taxOverridden: boolean;
  taxNote: string | null;
};

export type ResolveTaxInput = {
  /** `Document.status`. */
  status: string;
  document: DocumentTaxRow;
  suggestion: TaxSuggestion;
};

export type TaxFigures = { taxTreatment: TaxTreatment; taxName: string; taxRate: string };

export type ResolvedTax = TaxFigures & {
  /** What to write back to the row, or null when it already agrees. Always
   * null for a frozen or overridden document. */
  refresh: TaxFigures | null;
  /** Why the document cannot be finalized as it stands, or null. */
  blocker: string | null;
};

export function resolveDocumentTax(input: ResolveTaxInput): ResolvedTax {
  const { document, suggestion } = input;
  const current: TaxFigures = {
    taxTreatment: document.taxTreatment,
    taxName: document.taxName,
    taxRate: document.taxRate,
  };

  if (input.status !== "DRAFT") {
    return { ...current, refresh: null, blocker: null };
  }

  if (document.taxOverridden) {
    return {
      ...current,
      refresh: null,
      blocker: document.taxNote?.trim() ? null : "Give a reason for the custom tax",
    };
  }

  const next: TaxFigures = {
    taxTreatment: suggestion.treatment,
    taxName: suggestion.taxName,
    taxRate: suggestion.taxRate,
  };
  // Numeric rate comparison: "10" and "10.00" are the same Decimal.
  const changed =
    next.taxTreatment !== current.taxTreatment ||
    next.taxName !== current.taxName ||
    Number(next.taxRate) !== Number(current.taxRate);

  return { ...next, refresh: changed ? next : null, blocker: suggestion.blocker };
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/document-tax.test.ts tests/tax-rules.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/documents/tax.ts tests/document-tax.test.ts
git commit -m "feat(tax): resolve a quote's tax from freeze, custom override or suggestion"
```

### Task 3: Validation — incoterm, custom tax, region country

**Files:**
- Modify: `src/lib/validation/documents.ts` (the `deliveryTermsSchema` block, ~lines 153–162)
- Modify: `src/lib/validation/regions.ts` (`regionFormFields`, ~line 163)
- Test: `tests/documents-validation.test.ts`, `tests/regions-validation.test.ts`

- [ ] **Step 1: Write failing tests**

Append to `tests/documents-validation.test.ts` (add `incotermSchema, documentTaxSchema` to its import list from `../src/lib/validation/documents` — match the existing import path style in that file):

```ts
describe("incotermSchema", () => {
  accepts(incotermSchema, [
    ["EXW", "EXW"],
    ["DAP", "DAP"],
    ["DDP", "DDP"],
    ["FOB", "FOB"],
  ]);
  rejects(incotermSchema, [
    ["the retired DELIVERED", "DELIVERED"],
    ["the retired EX_WORKS", "EX_WORKS"],
    ["an Incoterm we do not use", "CIF"],
    ["blank", ""],
  ]);
});

describe("documentTaxSchema", () => {
  it("accepts Auto with nothing else", () => {
    expect(documentTaxSchema.safeParse({ mode: "AUTO" }).success).toBe(true);
  });

  it("accepts a full Custom tax and trims it", () => {
    const result = documentTaxSchema.safeParse({
      mode: "CUSTOM",
      taxName: " Sales Tax (Texas) ",
      taxRate: "8.25",
      taxNote: " Delivered to Austin ",
    });
    expect(result.success).toBe(true);
    if (result.success && result.data.mode === "CUSTOM") {
      expect(result.data.taxName).toBe("Sales Tax (Texas)");
      expect(result.data.taxNote).toBe("Delivered to Austin");
    }
  });

  it("saves a Custom tax whose reason is still blank (finalize blocks it, not save)", () => {
    const result = documentTaxSchema.safeParse({ mode: "CUSTOM", taxName: "Tax exempt", taxRate: "0", taxNote: "" });
    expect(result.success).toBe(true);
  });

  it("rejects Custom without a name or with a bad rate", () => {
    expect(documentTaxSchema.safeParse({ mode: "CUSTOM", taxName: "", taxRate: "5", taxNote: "x" }).success).toBe(false);
    expect(documentTaxSchema.safeParse({ mode: "CUSTOM", taxName: "VAT", taxRate: "-1", taxNote: "x" }).success).toBe(false);
    expect(documentTaxSchema.safeParse({ mode: "CUSTOM", taxName: "VAT", taxRate: "8.255", taxNote: "x" }).success).toBe(false);
  });

  it("rejects a reason over 200 characters", () => {
    expect(
      documentTaxSchema.safeParse({ mode: "CUSTOM", taxName: "VAT", taxRate: "5", taxNote: "x".repeat(201) }).success
    ).toBe(false);
  });
});
```

In `tests/regions-validation.test.ts`:
1. Add `regionCountrySchema` to the import list.
2. Add `country: "AU",` to **both** `base` objects (the `createRegionSchema` one ~line 160 and the `updateRegionSchema` one ~line 235).
3. Append:

```ts
describe("regionCountrySchema", () => {
  accepts(regionCountrySchema, [
    ["an ISO code", "AU"],
    ["a lowercase code, normalized to uppercase", "gb", "GB"],
  ]);
  rejects(regionCountrySchema, [
    ["the non-ISO UK", "UK"],
    ["blank", ""],
    ["a name", "Australia"],
  ]);
});

it("createRegionSchema requires a country", () => {
  const withoutCountry = {
    code: "AU", name: "Australia", currency: "AUD", taxName: "GST", taxRate: "10.00",
    entityName: "Pathfinder Australia Pty Ltd", active: "on",
  };
  expect(createRegionSchema.safeParse(withoutCountry).success).toBe(false);
  expect(createRegionSchema.safeParse({ ...withoutCountry, country: "AU" }).success).toBe(true);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/documents-validation.test.ts tests/regions-validation.test.ts`
Expected: FAIL (`incotermSchema`/`documentTaxSchema`/`regionCountrySchema` undefined).

- [ ] **Step 3: Implement**

In `src/lib/validation/documents.ts`, add this block directly **below** the existing `// --- delivery terms ...` block. Leave `deliveryTermsSchema` in place for now: `presentation.ts` still imports it, and Task 7 deletes both together so the app keeps compiling between tasks.

```ts
// --- delivery & tax ----------------------------------------------------------

/** `setIncoterm`'s input — the four Incoterms Pathfinder actually uses
 * (Vadym, 2026-09-30). Add more to `INCOTERMS` only when asked. */
export const incotermSchema = z.enum(INCOTERMS);

/** `setDocumentTax`'s input. AUTO hands the tax back to the suggestion
 * (src/lib/documents/tax-rules.ts). CUSTOM is the salesperson's own name and
 * rate; the reason may be saved blank while they are still typing — finalize
 * refuses a blank reason (see `resolveDocumentTax`), save does not. */
export const documentTaxSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("AUTO") }),
  z.object({
    mode: z.literal("CUSTOM"),
    taxName: taxNameSchema,
    taxRate: taxRateSchema,
    taxNote: z.string().trim().max(200, "Reason must be at most 200 characters").default(""),
  }),
]);
export type DocumentTaxInput = z.infer<typeof documentTaxSchema>;
```

and add to the imports at the top of the file:

```ts
import { INCOTERMS } from "@/lib/documents/tax-rules";
import { taxNameSchema, taxRateSchema } from "./regions";
```

(`regions.ts` does not import `documents.ts`, so there is no cycle. `tax-rules.ts` is pure.)

In `src/lib/validation/regions.ts`, add below `taxRateSchema`:

```ts
/** The selling entity's country (ISO 3166-1 alpha-2) — the "seller" side of
 * every tax suggestion (src/lib/documents/tax-rules.ts). Note the UK region's
 * code is "UK" but its country is "GB". */
export const regionCountrySchema = z
  .string()
  .trim()
  .toUpperCase()
  .refine(isValidCountryCode, { message: "Choose the region's country" });
```

import `isValidCountryCode` from `@/lib/countries`, and add `country: regionCountrySchema,` to `regionFormFields` right after `name`.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/documents-validation.test.ts tests/regions-validation.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/validation/documents.ts src/lib/validation/regions.ts tests/documents-validation.test.ts tests/regions-validation.test.ts
git commit -m "feat(tax): validate incoterm, custom tax and region country"
```


### Task 4: What the quotation prints (pure)

**Files:**
- Create: `src/lib/documents/tax-print.ts`
- Test: `tests/tax-print.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/tax-print.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { printsTaxRow, reverseChargeNote, taxBannerNote, taxRowLabel, type PrintableTax } from "@/lib/documents/tax-print";

const std: PrintableTax = { incoterm: "DAP", taxTreatment: "STANDARD", taxName: "GST", taxRate: "10.00", customerTaxId: null };

describe("taxBannerNote", () => {
  it.each<[string, PrintableTax, string]>([
    ["standard", std, "(DAP, incl. GST 10%)"],
    ["standard at 0%", { ...std, taxName: "Sales Tax", taxRate: "0.00" }, "(DAP)"],
    ["export", { ...std, incoterm: "FOB", taxTreatment: "EXPORT", taxRate: "0.00" }, "(FOB, export — no GST)"],
    ["reverse charge", { ...std, taxTreatment: "REVERSE_CHARGE", taxName: "VAT", taxRate: "0.00" }, "(DAP, VAT reverse charge)"],
    ["custom", { ...std, incoterm: "DDP", taxTreatment: "CUSTOM", taxName: "Sales Tax (Texas)", taxRate: "8.25" }, "(DDP, incl. Sales Tax (Texas) 8.25%)"],
    ["custom at 0%", { ...std, incoterm: "EXW", taxTreatment: "CUSTOM", taxName: "Tax exempt", taxRate: "0" }, "(EXW, Tax exempt)"],
  ])("%s", (_label, tax, expected) => {
    expect(taxBannerNote(tax)).toBe(expected);
  });
});

describe("printsTaxRow / taxRowLabel", () => {
  it("prints a row only for a charged tax", () => {
    expect(printsTaxRow(std)).toBe(true);
    expect(printsTaxRow({ ...std, taxTreatment: "CUSTOM", taxRate: "8.25" })).toBe(true);
    expect(printsTaxRow({ ...std, taxRate: "0.00" })).toBe(false);
    expect(printsTaxRow({ ...std, taxTreatment: "EXPORT", taxRate: "0.00" })).toBe(false);
    expect(printsTaxRow({ ...std, taxTreatment: "REVERSE_CHARGE", taxRate: "0.00" })).toBe(false);
  });

  it("labels the row without trailing zeros", () => {
    expect(taxRowLabel(std)).toBe("GST 10%");
    expect(taxRowLabel({ ...std, taxName: "Sales Tax (Texas)", taxRate: "8.25" })).toBe("Sales Tax (Texas) 8.25%");
  });
});

describe("reverseChargeNote", () => {
  it("is null for anything but reverse charge", () => {
    expect(reverseChargeNote(std)).toBeNull();
  });

  it("names the customer's VAT ID", () => {
    expect(
      reverseChargeNote({ ...std, taxTreatment: "REVERSE_CHARGE", taxName: "VAT", taxRate: "0.00", customerTaxId: "DE123456789" })
    ).toBe("Reverse charge: VAT to be accounted for by the recipient. Customer VAT ID: DE123456789.");
  });

  it("still prints the legal line when the ID is missing (a frozen legacy quote)", () => {
    expect(reverseChargeNote({ ...std, taxTreatment: "REVERSE_CHARGE", taxName: "VAT", taxRate: "0.00" })).toBe(
      "Reverse charge: VAT to be accounted for by the recipient."
    );
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/tax-print.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement**

Create `src/lib/documents/tax-print.ts`:

```ts
/**
 * The words the customer's quotation uses for delivery and tax — the total
 * banner's note, whether the totals table carries a tax row, and the
 * reverse-charge legal line. Pure, so both sheet sections (total-banner.tsx,
 * investment-summary.tsx) and the tests share one wording.
 *
 * A 0% tax never prints as "GST 0%": that reads as a mistake. The banner
 * says why there is no tax instead (export, reverse charge, or the custom
 * name such as "Tax exempt"). `taxNote` — the salesperson's reason — is
 * internal and deliberately not part of this input.
 */
import type { Incoterm, TaxTreatment } from "./tax-rules";

export type PrintableTax = {
  incoterm: Incoterm;
  taxTreatment: TaxTreatment;
  taxName: string;
  taxRate: string;
  customerTaxId: string | null;
};

function rateText(rate: string): string {
  return String(Number(rate));
}

function charged(tax: PrintableTax): boolean {
  return Number(tax.taxRate) > 0;
}

export function printsTaxRow(tax: PrintableTax): boolean {
  return (tax.taxTreatment === "STANDARD" || tax.taxTreatment === "CUSTOM") && charged(tax);
}

export function taxRowLabel(tax: PrintableTax): string {
  return `${tax.taxName} ${rateText(tax.taxRate)}%`;
}

export function taxBannerNote(tax: PrintableTax): string {
  switch (tax.taxTreatment) {
    case "EXPORT":
      return `(${tax.incoterm}, export — no ${tax.taxName})`;
    case "REVERSE_CHARGE":
      return `(${tax.incoterm}, ${tax.taxName} reverse charge)`;
    case "CUSTOM":
      return charged(tax) ? `(${tax.incoterm}, incl. ${taxRowLabel(tax)})` : `(${tax.incoterm}, ${tax.taxName})`;
    case "STANDARD":
      return charged(tax) ? `(${tax.incoterm}, incl. ${taxRowLabel(tax)})` : `(${tax.incoterm})`;
  }
}

export function reverseChargeNote(tax: PrintableTax): string | null {
  if (tax.taxTreatment !== "REVERSE_CHARGE") return null;
  const id = tax.customerTaxId?.trim();
  return `Reverse charge: ${tax.taxName} to be accounted for by the recipient.${id ? ` Customer VAT ID: ${id}.` : ""}`;
}
```

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/tax-print.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/documents/tax-print.ts tests/tax-print.test.ts
git commit -m "feat(tax): one wording for delivery and tax on the quotation"
```

### Task 5: Schema, migration, seed, preview query

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/z59_tax_incoterms/migration.sql`
- Create: `scripts/sql/tax-migration-preview.sql`
- Modify: `prisma/seed-lib.ts`, `prisma/seed.ts`

- [ ] **Step 1: Edit `prisma/schema.prisma`**

1. Replace the `DeliveryTerms` enum **and its comment block** (the block that starts `// An export sale collected at the factory door ...`) with:

```prisma
// The four Incoterms Pathfinder actually uses (Vadym, 2026-09-30). Together
// with the seller's and the destination's country they drive the suggested
// tax -- see src/lib/documents/tax-rules.ts.
enum Incoterm {
  EXW
  DAP
  DDP
  FOB
}

// How a document's tax was arrived at, and what the quotation prints for it
// (src/lib/documents/tax-print.ts). STANDARD/EXPORT/REVERSE_CHARGE come from
// the suggestion; CUSTOM is the salesperson's own name and rate.
enum TaxTreatment {
  STANDARD
  EXPORT
  REVERSE_CHARGE
  CUSTOM
}
```

2. In `model Region`, after `name String`, add:

```prisma
  /// ISO 3166-1 alpha-2 country of the selling entity ("GB" for the UK
  /// region). The seller side of every tax suggestion.
  country          String
```

and change the `taxName`/`taxRate` comments to say they are the region's **standard domestic** tax.

3. In `model Document`, replace the `deliveryTerms` field and its 6-line comment with:

```prisma
  // taxName/taxRate above are the tax actually CHARGED (0 on an export), not
  // the region's nominal rate. recalcDocument keeps an Auto draft's figures
  // equal to the suggestion; taxOverridden = true means the salesperson's
  // CUSTOM figures, which are never overwritten; FINAL freezes everything
  // (src/lib/documents/tax.ts).
  incoterm          Incoterm            @default(DAP)
  taxTreatment      TaxTreatment        @default(STANDARD)
  taxOverridden     Boolean             @default(false)
  /// Why the salesperson chose a custom tax. Internal, never printed.
  taxNote           String?
```

and update the `currencySymbol` doc comment's mention of "taxName/taxRate beside it" if it now reads wrongly (it still holds: they are snapshotted at createDraft).

- [ ] **Step 2: Write the migration**

Create `prisma/migrations/z59_tax_incoterms/migration.sql`:

```sql
-- Tax & Incoterms per quote (docs/superpowers/specs/2026-09-30-tax-and-incoterms-design.md).
--
-- Touches Document rows (Vadym approved the spec, 2026-09-30, on condition
-- of a manual backup taken immediately before this runs). No row is deleted.
-- Finalized quotes keep their totals: only former EX_WORKS rows change, and
-- their taxAmount is already 0.

-- 1. The selling entity's country. Region codes are ISO codes except UK.
ALTER TABLE "Region" ADD COLUMN "country" TEXT;
UPDATE "Region" SET "country" = CASE UPPER("code") WHEN 'UK' THEN 'GB' ELSE UPPER("code") END;
ALTER TABLE "Region" ALTER COLUMN "country" SET NOT NULL;

-- 2. New enums and columns.
CREATE TYPE "Incoterm" AS ENUM ('EXW', 'DAP', 'DDP', 'FOB');
CREATE TYPE "TaxTreatment" AS ENUM ('STANDARD', 'EXPORT', 'REVERSE_CHARGE', 'CUSTOM');

ALTER TABLE "Document"
  ADD COLUMN "incoterm" "Incoterm" NOT NULL DEFAULT 'DAP',
  ADD COLUMN "taxTreatment" "TaxTreatment" NOT NULL DEFAULT 'STANDARD',
  ADD COLUMN "taxOverridden" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "taxNote" TEXT;

-- 3. DELIVERED -> DAP (the default above). EX_WORKS -> EXW, charged as an
--    export: taxRate now holds the rate actually charged, which for these
--    rows was always 0.
UPDATE "Document"
   SET "incoterm" = 'EXW',
       "taxTreatment" = 'EXPORT',
       "taxRate" = 0
 WHERE "deliveryTerms" = 'EX_WORKS';

-- 4. The old column and enum go; nothing reads them any more.
ALTER TABLE "Document" DROP COLUMN "deliveryTerms";
DROP TYPE "DeliveryTerms";
```

Stored revision snapshots (`QuoteRevision.snapshot`) are **not** rewritten. Task 9 bumps `REVISION_SNAPSHOT_VERSION` to 2 instead, which is the mechanism the snapshot module was built with. Side effect, accepted: re-finalizing a quote that was finalized before this deploy, without changing it, mints one extra `-R` revision. There are only a handful of such quotes.

- [ ] **Step 3: Write the read-only preview query**

Create `scripts/sql/tax-migration-preview.sql`:

```sql
-- READ-ONLY. Run against production BEFORE deploying z59_tax_incoterms to
-- list the drafts whose tax will change on their next recalc. Show the list
-- to Vadym. Finalized quotes are frozen and never appear here.
WITH d AS (
  SELECT doc.id,
         doc."number",
         r.code AS region,
         CASE UPPER(r.code) WHEN 'UK' THEN 'GB' ELSE UPPER(r.code) END AS seller,
         UPPER(TRIM(COALESCE(
           CASE WHEN c."deliverySameAsMain" THEN NULL ELSE NULLIF(TRIM(c."deliveryCountry"), '') END,
           c.country
         ))) AS destination,
         c.name AS client,
         doc."deliveryTerms",
         doc."taxName",
         doc."taxRate",
         doc.total
    FROM "Document" doc
    JOIN "Region" r ON r.id = doc."regionId"
    LEFT JOIN "Company" c ON c.id = doc."companyId"
   WHERE doc.status = 'DRAFT'
)
SELECT *,
       CASE
         WHEN destination IS NULL THEN 'no destination: finalize will ask for it'
         WHEN "deliveryTerms" = 'EX_WORKS' AND destination = seller THEN 'domestic EXW: tax goes from 0 to the region rate'
         WHEN "deliveryTerms" = 'DELIVERED' AND destination <> seller THEN 'foreign delivery: tax goes to 0 (export)'
       END AS change
  FROM d
 WHERE destination IS NULL
    OR ("deliveryTerms" = 'EX_WORKS' AND destination = seller)
    OR ("deliveryTerms" = 'DELIVERED' AND destination <> seller)
 ORDER BY region, client;
```

(Free-text legacy countries such as "Australia" show up as false positives. The app normalises them, this query does not. Say so when showing the list.)

- [ ] **Step 4: Seed**

In `prisma/seed-lib.ts`, add `country: string;` to the region seed type (next to `taxName`), and `country: "AU"`, `country: "US"`, `country: "GB"` to the AU, US and UK entries. In `prisma/seed.ts`, add `country: r.country,` to both the `update` and the `create` objects of the region upsert (~lines 71 and 83).

- [ ] **Step 5: Verify**

Run: `npx prisma validate`
Expected: `The schema at prisma/schema.prisma is valid`.

Run: `npx vitest run`
Expected: PASS. Vitest does not type-check, so fixtures that still carry the old `deliveryTerms` key keep running until Tasks 9–11 update them.

`npx prisma generate` will fail in the sandbox with EPERM. Do not chase the resulting `tsc` errors (see ground rules).

- [ ] **Step 6: Commit**

```bash
git add prisma/schema.prisma prisma/migrations/z59_tax_incoterms scripts/sql/tax-migration-preview.sql prisma/seed-lib.ts prisma/seed.ts
git commit -m "feat(tax): Incoterm and tax treatment on Document, country on Region"
```

### Task 6: `recalcDocument` persists the resolved tax and reports its blocker

**Files:**
- Modify: `src/lib/documents/recalc.ts`

`recalcDocument` imports `@/lib/db`, so it has no unit test. Its logic lives in the pure modules already tested in Tasks 1–2; this task only wires them in.

- [ ] **Step 1: Imports**

Next to `import { resolveDocumentTax } from "./tax";` add:

```ts
import { destinationCountry, suggestTax } from "./tax-rules";
```

- [ ] **Step 2: `RecalcResult` gains the blocker**

Add as the last field of `export type RecalcResult`:

```ts
  /** Why this document's tax cannot be finalized as it stands (DDP abroad,
   * missing VAT ID or delivery country, a custom tax with no reason), or
   * null. `finalizeDocument` refuses on it; saving is never blocked by it. */
  taxBlocker: string | null;
```

and add `taxBlocker: null,` to the "document not found" early return object.

- [ ] **Step 3: Load the company's countries**

In the `client.document.findUnique` `include`, add after `region: true,`:

```ts
      // The destination side of the tax suggestion, and the VAT ID reverse
      // charge needs (./tax-rules.ts).
      company: { select: { country: true, deliverySameAsMain: true, deliveryCountry: true, taxId: true } },
```

- [ ] **Step 4: Replace the tax resolution**

Replace the comment block and the `const tax = resolveDocumentTax({...});` call (the block starting `// The document's effective tax, with both of its rules`) with:

```ts
  // The document's tax: FINAL frozen, CUSTOM kept, an Auto draft following
  // the suggestion (./tax.ts and ./tax-rules.ts carry the reasoning). When
  // `refresh` is non-null the figures are written back in the same update
  // as the totals below, so "GST 10%" and the taxAmount beside it are two
  // views of one figure.
  const suggestion = suggestTax({
    sellerCountry: document.region.country,
    destinationCountry: destinationCountry(document.company),
    incoterm: document.incoterm,
    regionTax: { taxName: document.region.taxName, taxRate: document.region.taxRate.toString() },
    customerTaxId: document.company?.taxId ?? null,
  });
  const tax = resolveDocumentTax({
    status: document.status,
    document: {
      taxTreatment: document.taxTreatment,
      taxName: document.taxName,
      taxRate: document.taxRate.toString(),
      taxOverridden: document.taxOverridden,
      taxNote: document.taxNote,
    },
    suggestion,
  });
```

- [ ] **Step 5: Feed the engine and persist**

In `engineInput`, replace `taxRate: tax.engineTaxRate,` with:

```ts
    taxRate: Number(tax.taxRate),
```

In the `client.document.update` `data`, replace the `...(tax.refresh ? {...} : {})` spread with:

```ts
      ...(tax.refresh
        ? {
            taxTreatment: tax.refresh.taxTreatment,
            taxName: tax.refresh.taxName,
            taxRate: new Prisma.Decimal(tax.refresh.taxRate),
          }
        : {}),
```

In the final `return`, add `taxBlocker: tax.blocker,`.

- [ ] **Step 6: Verify**

Run: `npx vitest run && npx eslint src/lib/documents`
Expected: tests PASS, eslint clean. `tsc` will flag `document.incoterm`/`taxTreatment`/`region.country` until Prisma is regenerated; that is expected.

- [ ] **Step 7: Commit**

```bash
git add src/lib/documents/recalc.ts
git commit -m "feat(tax): recalc persists the suggested or custom tax and reports blockers"
```

### Task 7: Server actions `setIncoterm` and `setDocumentTax`

**Files:**
- Modify: `src/lib/actions/documents/presentation.ts` (header comment, imports, the `// --- delivery terms` section at the end)
- Modify: `src/lib/actions/documents.ts` (re-export list, ~line 49)
- Modify: `src/lib/validation/documents.ts` (delete `deliveryTermsSchema` + `DeliveryTermsInput` + their comment)

Both actions follow the pattern `setDeliveryTerms` uses today: parse, scoped DRAFT lookup, guarded transaction, `recalcAndEnforce`, `revalidateDocument`. Permission is the scope that `documentWhereForUser` already encodes: the author, a Regional manager in the region, Admin, Developer.

- [ ] **Step 1: Replace the delivery-terms section of `presentation.ts`**

Replace everything from `// --- delivery terms (Ex Works carries no GST) ---` to the end of `setDeliveryTerms` with:

```ts
// --- delivery & tax -----------------------------------------------------------

/**
 * Sets `Document.incoterm`. It moves the suggested tax (a domestic EXW is
 * taxed, a foreign FOB is not — src/lib/documents/tax-rules.ts), so it takes
 * the same guarded transaction + `recalcAndEnforce` as every money-affecting
 * mutation here. DRAFT-only, scoped like every other document mutation.
 */
export async function setIncoterm(documentId: string, formData: FormData): Promise<ActionResult> {
  const session = await requireSession();

  const parsedDocumentId = idSchema.safeParse(documentId);
  if (!parsedDocumentId.success) return { error: NOT_FOUND_ERROR };

  const parsedIncoterm = incotermSchema.safeParse(formData.get("incoterm"));
  if (!parsedIncoterm.success) return { error: flattenZodError(parsedIncoterm.error) };

  const document = await db.document.findFirst({
    where: { id: parsedDocumentId.data, status: "DRAFT", ...documentWhereForUser(session.user) },
  });
  if (!document) return { error: NOT_FOUND_ERROR };

  let concessionWarning: string | undefined;
  try {
    await db.$transaction(async (tx) => {
      await assertStillDraft(tx, document.id);
      await tx.document.update({ where: { id: document.id }, data: { incoterm: parsedIncoterm.data } });
      concessionWarning = (await recalcAndEnforce(document.id, tx, session.user.role)).warning;
    });
  } catch (error) {
    return mapDraftWriteError(error);
  }

  revalidateDocument(document.id);
  return concessionWarning ? { warning: concessionWarning } : {};
}

/**
 * Chooses the document's tax: AUTO hands it back to the suggestion (the
 * next recalc writes the suggested figures), CUSTOM stores the
 * salesperson's own name, rate and reason and marks them overridden so no
 * recalc touches them (src/lib/documents/tax.ts). Free for anyone who may
 * edit the draft; the reason is what makes an override visible (Vadym,
 * 2026-09-30). A blank reason saves and blocks finalize instead.
 */
export async function setDocumentTax(documentId: string, formData: FormData): Promise<ActionResult> {
  const session = await requireSession();

  const parsedDocumentId = idSchema.safeParse(documentId);
  if (!parsedDocumentId.success) return { error: NOT_FOUND_ERROR };

  const parsed = documentTaxSchema.safeParse({
    mode: formData.get("mode"),
    taxName: formData.get("taxName") ?? undefined,
    taxRate: formData.get("taxRate") ?? undefined,
    taxNote: formData.get("taxNote") ?? undefined,
  });
  if (!parsed.success) return { error: flattenZodError(parsed.error) };
  const input = parsed.data;

  const document = await db.document.findFirst({
    where: { id: parsedDocumentId.data, status: "DRAFT", ...documentWhereForUser(session.user) },
  });
  if (!document) return { error: NOT_FOUND_ERROR };

  const data =
    input.mode === "AUTO"
      ? { taxOverridden: false, taxNote: null }
      : {
          taxOverridden: true,
          taxTreatment: "CUSTOM" as const,
          taxName: input.taxName,
          taxRate: new Prisma.Decimal(input.taxRate),
          taxNote: input.taxNote === "" ? null : input.taxNote,
        };

  let concessionWarning: string | undefined;
  try {
    await db.$transaction(async (tx) => {
      await assertStillDraft(tx, document.id);
      await tx.document.update({ where: { id: document.id }, data });
      concessionWarning = (await recalcAndEnforce(document.id, tx, session.user.role)).warning;
    });
  } catch (error) {
    return mapDraftWriteError(error);
  }

  revalidateDocument(document.id);
  return concessionWarning ? { warning: concessionWarning } : {};
}
```

Imports in `presentation.ts`: in the `@/lib/validation/documents` import, replace `deliveryTermsSchema,` with `documentTaxSchema,` and `incotermSchema,` (keep the list alphabetical), and add `import { Prisma } from "@prisma/client";` at the top.

In the file header comment, replace "and the delivery terms" / "the one exception is `setDeliveryTerms`, which moves the tax" with "and the delivery & tax choice" / "the exceptions are `setIncoterm` and `setDocumentTax`, which move the tax".

- [ ] **Step 2: Re-exports**

In `src/lib/actions/documents.ts`, replace `setDeliveryTerms,` with:

```ts
  setIncoterm,
  setDocumentTax,
```

- [ ] **Step 3: Delete the retired schema**

In `src/lib/validation/documents.ts`, delete the old `// --- delivery terms (Ex Works carries no GST) ---` comment, `deliveryTermsSchema` and `DeliveryTermsInput`.

- [ ] **Step 4: Verify nothing else references them**

Run: `grep -rn "setDeliveryTerms\|deliveryTermsSchema\|DeliveryTermsInput" src tests`
Expected: only `src/components/builder/delivery-terms-field.tsx` (deleted in Task 12) and comments in `src/lib/queries/documents-builder.ts` (rewritten in Task 10). Nothing else.

Run: `npx vitest run && npx eslint src/lib/actions src/lib/validation`
Expected: PASS, clean.

- [ ] **Step 5: Commit**

```bash
git add src/lib/actions/documents/presentation.ts src/lib/actions/documents.ts src/lib/validation/documents.ts
git commit -m "feat(tax): actions to set a quote's incoterm and its auto or custom tax"
```

### Task 8: Finalize refuses a tax blocker; the readiness panel shows it

**Files:**
- Modify: `src/lib/actions/finalize.ts` (~line 145, the `recalcDocument` destructure, and after `validateFinalizable`)
- Modify: `src/lib/quote-readiness.ts`
- Test: `tests/quote-readiness.test.ts`

- [ ] **Step 1: Failing readiness tests**

In `tests/quote-readiness.test.ts`, add `taxBlocker: null,` to the `input()` fixture (after `pathWorksModulesWithoutHost`), then append:

```ts
describe("quoteReadiness — delivery & tax", () => {
  it("adds no tax row when the tax is settled", () => {
    expect(quoteReadiness(input()).some((row) => row.key === "tax")).toBe(false);
  });

  it("adds a blocking tax row pointing at the Setup tab", () => {
    const row = quoteReadiness(input({ taxBlocker: "DDP abroad: set Canada's tax with Custom" })).find((r) => r.key === "tax");
    expect(row).toMatchObject({
      label: "Delivery & tax",
      met: false,
      needsAttention: true,
      blocking: true,
      targetTab: "settings",
      detail: "DDP abroad: set Canada's tax with Custom",
    });
  });

  it("stays quiet until a company is chosen — the client row already says so", () => {
    const rows = quoteReadiness(input({ hasCompany: false, taxBlocker: "Set the client's delivery country" }));
    expect(rows.some((row) => row.key === "tax")).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/quote-readiness.test.ts`
Expected: FAIL on the second test (no `tax` row).

- [ ] **Step 3: Implement the row**

In `src/lib/quote-readiness.ts`:

1. `export type ReadinessKey = "client" | "items" | "spec" | "documents" | "pathworks" | "tax";`
2. Add to `ReadinessInput`:

```ts
  /** `RecalcResult.taxBlocker` / `DocumentForBuilder.taxBlocker` — why the
   *  quote's tax cannot be finalized, or null. Mirrors the refusal in
   *  `finalizeDocument` one for one. */
  taxBlocker: string | null;
```

3. In `quoteReadiness`, insert before the PathWorks spread:

```ts
    // Only once a company is chosen: before that the client row already
    // blocks, and "set the delivery country" would just repeat it.
    ...(input.hasCompany && input.taxBlocker ? [taxRow(input.taxBlocker)] : []),
```

4. Add:

```ts
function taxRow(blocker: string): ReadinessRow {
  return {
    key: "tax",
    label: "Delivery & tax",
    met: false,
    needsAttention: true,
    detail: blocker,
    targetTab: "settings",
    targetItemId: null,
    blocking: true,
  };
}
```

If `src/components/builder/readiness-panel.tsx` switches over `ReadinessKey` exhaustively (e.g. an icon map `Record<ReadinessKey, ...>`), add a `tax` entry there using the `Truck` icon from `lucide-react`.

- [ ] **Step 4: Enforce in finalize**

In `src/lib/actions/finalize.ts`, change

```ts
      const { violations, documentConcession, commission } = await recalcDocument(document.id, tx);
```

to

```ts
      const { violations, documentConcession, commission, taxBlocker } = await recalcDocument(document.id, tx);
```

and directly after `if (validationError) throw new NotFinalizableError(validationError);` add:

```ts
      // The tax the app could not decide (DDP abroad, reverse charge without
      // a VAT ID, no delivery country, a custom tax with no reason). Same
      // rule the readiness panel shows before the click.
      if (taxBlocker) throw new NotFinalizableError(taxBlocker);
```

- [ ] **Step 5: Run tests**

Run: `npx vitest run tests/quote-readiness.test.ts tests/finalize-validation.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/quote-readiness.ts src/lib/actions/finalize.ts tests/quote-readiness.test.ts src/components/builder/readiness-panel.tsx
git commit -m "feat(tax): finalize refuses an undecided tax and the readiness panel says why"
```

### Task 9: Revision snapshot v2 (`incoterm` + `taxTreatment`)

**Files:**
- Modify: `src/lib/documents/revision-snapshot.ts` (`RevisionSnapshotInput` ~line 160, `REVISION_SNAPSHOT_VERSION` ~187, `RevisionSnapshot` ~189, `buildRevisionSnapshot` ~253, `DocumentRowForSnapshot` ~306, `documentToRevisionSnapshotInput` ~427)
- Test: `tests/revision-snapshot.test.ts`

- [ ] **Step 1: Update the tests first**

In `tests/revision-snapshot.test.ts`:
- In both fixtures (~lines 126 and 279), replace `deliveryTerms: "DELIVERED",` with:

```ts
  incoterm: "DAP",
  taxTreatment: "STANDARD",
```

- Replace line ~241 `expect(hashOf({ ...base, deliveryTerms: "EX_WORKS" })).not.toBe(hashOf(base));` with:

```ts
    expect(hashOf({ ...base, incoterm: "EXW" })).not.toBe(hashOf(base));
    expect(hashOf({ ...base, taxTreatment: "EXPORT" })).not.toBe(hashOf(base));
```

and rename that `it(...)` title's "delivery terms" to "incoterm, tax treatment".

- Append inside the file:

```ts
it("is version 2 — incoterm and tax treatment replaced deliveryTerms", () => {
  expect(REVISION_SNAPSHOT_VERSION).toBe(2);
  const snapshot = buildRevisionSnapshot(base) as unknown as Record<string, unknown>;
  expect(snapshot.incoterm).toBe("DAP");
  expect(snapshot.taxTreatment).toBe("STANDARD");
  expect("deliveryTerms" in snapshot).toBe(false);
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/revision-snapshot.test.ts`
Expected: FAIL (version is 1, `incoterm` undefined).

- [ ] **Step 3: Implement**

In `src/lib/documents/revision-snapshot.ts`, in each of `RevisionSnapshotInput`, `RevisionSnapshot` and `DocumentRowForSnapshot`, replace `deliveryTerms: string;` with:

```ts
  incoterm: string;
  taxTreatment: string;
```

In `buildRevisionSnapshot`, replace `deliveryTerms: input.deliveryTerms,` with:

```ts
    incoterm: input.incoterm,
    taxTreatment: input.taxTreatment,
```

In `documentToRevisionSnapshotInput`, replace `deliveryTerms: document.deliveryTerms,` with:

```ts
    incoterm: document.incoterm,
    taxTreatment: document.taxTreatment,
```

Change `export const REVISION_SNAPSHOT_VERSION = 1 as const;` to `2 as const` and append to its doc comment:

```ts
 *
 * v2 (2026-09-30): `deliveryTerms` replaced by `incoterm` + `taxTreatment`.
 * v1 snapshots stay in the database untouched; the only effect is that the
 * first re-finalize of a v1 quote mints a new revision even if nothing
 * changed.
```

`taxOverridden`/`taxNote` are deliberately not in the snapshot: the note is internal, and a custom tax already shows as `taxTreatment: "CUSTOM"` with its own name and rate.

- [ ] **Step 4: Run tests**

Run: `npx vitest run tests/revision-snapshot.test.ts tests/revision-plan.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/lib/documents/revision-snapshot.ts tests/revision-snapshot.test.ts
git commit -m "feat(tax): revision snapshot v2 records incoterm and tax treatment"
```

### Task 10: Carry incoterm, treatment and VAT ID to the sheet, builder and signing page

**Files:**
- Modify: `src/lib/sheet-data.ts` (`ToSheetCompanyInput` ~92, `ToSheetDataDoc.deliveryTerms` ~165, `DocSheetTotals.deliveryTerms` ~421, `toSheetData` totals ~831)
- Modify: `src/lib/queries/documents-builder.ts` (`BuilderCompany` ~32, `DocumentForBuilder.deliveryTerms` ~271, return object ~821, company mapping ~854)
- Modify: `src/lib/queries/signing.ts` (select ~179, company select, company mapping ~420, `signingDocument` ~458)
- Modify: `tests/helpers/fixtures.ts`, `tests/sheet-data.test.ts`

- [ ] **Step 1: Update fixtures and the sheet-data test**

`tests/helpers/fixtures.ts`:
- in `sheetCompany`, add `taxId: null,` after `website: null,`;
- in the doc fixture (~line 94), replace `deliveryTerms: "DELIVERED",` with `incoterm: "DAP",` and `taxTreatment: "STANDARD",`.

`tests/sheet-data.test.ts`:
- in the expected `sheet.totals` object (~line 460), replace `deliveryTerms: "DELIVERED",` with:

```ts
      incoterm: "DAP",
      taxTreatment: "STANDARD",
      customerTaxId: null,
```

- replace the `it("carries deliveryTerms straight through, ...")` test with:

```ts
  it("carries incoterm and tax treatment straight through", () => {
    const sheet = toSheetData(sheetDoc({ incoterm: "FOB", taxTreatment: "EXPORT" }));
    expect(sheet.totals.incoterm).toBe("FOB");
    expect(sheet.totals.taxTreatment).toBe("EXPORT");
  });

  it("puts the client's VAT ID beside the totals for the reverse-charge line", () => {
    const sheet = toSheetData(sheetDoc({ company: sheetCompany({ taxId: "DE123456789" }) }));
    expect(sheet.totals.customerTaxId).toBe("DE123456789");
    expect(toSheetData(sheetDoc({ company: null })).totals.customerTaxId).toBeNull();
  });
```

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/sheet-data.test.ts`
Expected: FAIL (`totals.incoterm` undefined).

- [ ] **Step 3: `src/lib/sheet-data.ts`**

Add at the top: `import type { Incoterm, TaxTreatment } from "@/lib/documents/tax-rules";`

`ToSheetCompanyInput`: add after `website`:

```ts
  /** The client's tax/VAT ID. Printed only on a reverse-charge quote. */
  taxId: string | null;
```

`ToSheetDataDoc`: replace the `deliveryTerms` field and its comment with:

```ts
  /** See `Incoterm`/`TaxTreatment` in src/lib/documents/tax-rules.ts. The
   * totals below are already resolved (recalcDocument); these only decide
   * the wording (src/lib/documents/tax-print.ts). */
  incoterm: Incoterm;
  taxTreatment: TaxTreatment;
```

`DocSheetTotals`: replace the `deliveryTerms` field and its comment with:

```ts
  /** Wording inputs for src/lib/documents/tax-print.ts — see
   * `ToSheetDataDoc.incoterm`. `customerTaxId` is `company.taxId`, printed
   * only on a reverse-charge quote. */
  incoterm: Incoterm;
  taxTreatment: TaxTreatment;
  customerTaxId: string | null;
```

`toSheetData` totals: replace `deliveryTerms: doc.deliveryTerms,` with:

```ts
      incoterm: doc.incoterm,
      taxTreatment: doc.taxTreatment,
      customerTaxId: doc.company?.taxId ?? null,
```

- [ ] **Step 4: `src/lib/queries/documents-builder.ts`**

Add imports:

```ts
import { destinationCountry, suggestTax, type Incoterm, type TaxSuggestion, type TaxTreatment } from "@/lib/documents/tax-rules";
import { resolveDocumentTax } from "@/lib/documents/tax";
```

`BuilderCompany`: add `taxId: string | null;` after `website`.

`DocumentForBuilder`: replace the `deliveryTerms` field and its comment with:

```ts
  incoterm: Incoterm;
  /** The document's stored tax (Task 6 keeps an Auto draft equal to the
   * suggestion, so these are what the totals were computed with). */
  taxTreatment: TaxTreatment;
  taxOverridden: boolean;
  /** Internal reason for a custom tax. Never printed. */
  taxNote: string | null;
  /** What Auto would charge right now, with its one-line reason. The
   * Delivery & tax card shows it under "Auto", and as "differs from
   * suggestion" under Custom. */
  taxSuggestion: TaxSuggestion;
  /** Same value `recalcDocument` returns as `taxBlocker`. */
  taxBlocker: string | null;
  /** ISO codes for the card's "Route" line. */
  sellerCountry: string;
  destinationCountry: string | null;
```

In `loadDocumentForBuilder`, just before the `return {`, add:

```ts
  const destination = destinationCountry(document.company);
  const taxSuggestion = suggestTax({
    sellerCountry: document.region.country,
    destinationCountry: destination,
    incoterm: document.incoterm,
    regionTax: { taxName: document.region.taxName, taxRate: document.region.taxRate.toString() },
    customerTaxId: document.company?.taxId ?? null,
  });
  const taxBlocker = resolveDocumentTax({
    status: document.status,
    document: {
      taxTreatment: document.taxTreatment,
      taxName: document.taxName,
      taxRate: document.taxRate.toString(),
      taxOverridden: document.taxOverridden,
      taxNote: document.taxNote,
    },
    suggestion: taxSuggestion,
  }).blocker;
```

In the returned object, replace `deliveryTerms: document.deliveryTerms,` with:

```ts
    incoterm: document.incoterm,
    taxTreatment: document.taxTreatment,
    taxOverridden: document.taxOverridden,
    taxNote: document.taxNote,
    taxSuggestion,
    taxBlocker,
    sellerCountry: document.region.country,
    destinationCountry: destination,
```

and in the `company` mapping add `taxId: document.company.taxId,` after `website`.

`document.company` is loaded with `include`, so it already has `country`, `deliverySameAsMain`, `deliveryCountry` and `taxId`; `region: true` has `country`.

- [ ] **Step 5: `src/lib/queries/signing.ts`**

- In the document `select`, replace `deliveryTerms: true,` with `incoterm: true,` and `taxTreatment: true,`.
- In the `company: { select: { ... } }`, add `taxId: true,`.
- In the company mapping (~line 420), add `taxId: document.company.taxId,` after `website`.
- In `signingDocument`, replace `deliveryTerms: document.deliveryTerms,` with `incoterm: document.incoterm,` and `taxTreatment: document.taxTreatment,`.

- [ ] **Step 6: Find every other reader**

Run: `grep -rn "deliveryTerms" src tests`
Expected remaining hits: `src/components/sheet/sections/*.tsx` (Task 11), `src/components/builder/delivery-terms-field.tsx` and `src/app/(app)/quotes/[documentId]/page.tsx` (Task 12), `tests/pdf.test.ts` (Task 11). Anything else: update it the same way before committing.

- [ ] **Step 7: Run tests**

Run: `npx vitest run`
Expected: PASS except possibly `tests/pdf.test.ts` assertions on "(Ex Works)" (Task 11 rewrites them).

- [ ] **Step 8: Commit**

```bash
git add src/lib/sheet-data.ts src/lib/queries/documents-builder.ts src/lib/queries/signing.ts tests/helpers/fixtures.ts tests/sheet-data.test.ts
git commit -m "feat(tax): builder, sheet and signing page carry incoterm, tax treatment and VAT ID"
```

### Task 11: The quotation prints the new wording

**Files:**
- Modify: `src/components/sheet/sections/total-banner.tsx` (~lines 23–28)
- Modify: `src/components/sheet/sections/investment-summary.tsx` (~lines 138–150, plus the note after the TOTAL row)
- Modify: `src/components/sheet/sheet-css.ts` (after `.pq-totals-final`, ~line 826)
- Test: `tests/pdf.test.ts` (~lines 835–870, and every `deliveryTerms:` fixture at ~85, 887, 907, 1009)

- [ ] **Step 1: Update the rendering tests**

In `tests/pdf.test.ts`, in every `totals` fixture, replace `deliveryTerms: "DELIVERED",` with:

```ts
          incoterm: "DAP",
          taxTreatment: "STANDARD",
          customerTaxId: null,
```

(line ~85 is the base fixture; keep its indentation).

Replace the Ex Works test (the one asserting `"(Ex Works)"`, ~835–858) and the "still prints the ordinary tax-rate line when DELIVERED" test after it with:

```ts
  const totalsWith = (over: Record<string, unknown>) => ({
    currency: "AUD",
    currencySymbol: null,
    subtotal: "1000.00",
    discountMode: "PERCENT" as const,
    discountValue: null,
    discountAmount: "0.00",
    taxName: "GST",
    taxRate: "10",
    taxAmount: "100.00",
    total: "1100.00",
    incoterm: "DAP" as const,
    taxTreatment: "STANDARD" as const,
    customerTaxId: null,
    ...over,
  });

  it("prints the incoterm and the charged tax on a standard quote", async () => {
    const html = await renderQuotationHtml(baseQuotationData({ totals: totalsWith({}) }));
    expect(html).toContain("(DAP, incl. GST 10%)");
    expect(html).toContain("GST 10%");
  });

  it("prints an export with no tax row and no 'GST 0%'", async () => {
    const html = await renderQuotationHtml(
      baseQuotationData({
        totals: totalsWith({ incoterm: "EXW", taxTreatment: "EXPORT", taxRate: "0.00", taxAmount: "0.00", total: "1000.00" }),
      })
    );
    expect(html).toContain("(EXW, export — no GST)");
    expect(html).not.toContain("GST 0%");
    expect(html).not.toContain("incl. GST");
  });

  it("prints the reverse-charge line with the client's VAT ID", async () => {
    const html = await renderQuotationHtml(
      baseQuotationData({
        totals: totalsWith({
          taxName: "VAT",
          taxTreatment: "REVERSE_CHARGE",
          taxRate: "0.00",
          taxAmount: "0.00",
          total: "1000.00",
          customerTaxId: "DE123456789",
        }),
      })
    );
    expect(html).toContain("(DAP, VAT reverse charge)");
    expect(html).toContain("Reverse charge: VAT to be accounted for by the recipient. Customer VAT ID: DE123456789.");
  });

  it("prints a custom tax by its own name", async () => {
    const html = await renderQuotationHtml(
      baseQuotationData({
        totals: totalsWith({ incoterm: "DDP", taxTreatment: "CUSTOM", taxName: "Sales Tax (Texas)", taxRate: "8.25", taxAmount: "82.50", total: "1082.50" }),
      })
    );
    expect(html).toContain("(DDP, incl. Sales Tax (Texas) 8.25%)");
    expect(html).toContain("Sales Tax (Texas) 8.25%");
  });
```

If the surrounding `describe` title mentions Ex Works, rename it to `"renderQuotationHtml — delivery & tax wording"`. Search the rest of the file for `"Ex Works"` / `"Delivered, incl."` expectations and update them to the new wording.

- [ ] **Step 2: Run to verify failure**

Run: `npx vitest run tests/pdf.test.ts`
Expected: FAIL on the new wording.

- [ ] **Step 3: Total banner**

In `total-banner.tsx`, import `import { taxBannerNote } from "@/lib/documents/tax-print";` and replace the note span's contents (the comment and the `deliveryTerms === "EX_WORKS"` ternary) with:

```tsx
        {/* Incoterm and tax in one line (src/lib/documents/tax-print.ts). */}
        {taxBannerNote(totals)}
```

- [ ] **Step 4: Investment summary**

In `investment-summary.tsx`, import:

```ts
import { printsTaxRow, reverseChargeNote, taxRowLabel } from "@/lib/documents/tax-print";
```

Replace the `{totals.deliveryTerms === "EX_WORKS" ? (...) : (...)}` block with:

```tsx
        {/* A 0% tax prints no row: "GST 0%" reads as a mistake, and the
            banner already says why (export, reverse charge, exempt). */}
        {printsTaxRow(totals) ? (
          <div className="pq-totals-row">
            <span>{taxRowLabel(totals)}</span>
            <span>{formatMoney(totals.taxAmount, totals.currency, totals.currencySymbol)}</span>
          </div>
        ) : null}
```

Directly after the `pq-totals-final` row's closing `</div>` (still inside `.pq-totals`), add:

```tsx
        {reverseChargeNote(totals) ? <p className="pq-totals-note">{reverseChargeNote(totals)}</p> : null}
```

- [ ] **Step 5: CSS**

In `sheet-css.ts`, after the `.pq-totals-final { ... }` rule, add:

```css
  .pq-totals-note {
    margin: 6px 0 0;
    font-size: 9px;
    line-height: 1.35;
    color: #555555;
  }
```

- [ ] **Step 6: Run tests**

Run: `npx vitest run tests/pdf.test.ts tests/quotation-data.test.ts tests/form-sheet-css.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add src/components/sheet tests/pdf.test.ts
git commit -m "feat(tax): quotation prints incoterm, export, reverse charge and custom tax"
```

### Task 12: Builder — the "Delivery & tax" card

**Files:**
- Create: `src/components/builder/delivery-tax-field.tsx`
- Delete: `src/components/builder/delivery-terms-field.tsx`
- Modify: `src/app/(app)/quotes/[documentId]/page.tsx` (import ~line 51, `quoteReadiness({...})` ~268, the Delivery terms `SectionCard` ~444–455, `<DocumentTotals .../>` ~582)
- Modify: `src/components/builder/sticky-footer.tsx` (`TotalsProps` ~8, `DocumentTotals` tax row ~62)
- Modify: `src/components/ui-kit/read-only-value.tsx` (comment only: `DeliveryTermsField` → `DeliveryTaxField`)

UI components have no unit tests in this repo. Verification is eslint plus the manual check in Step 6.

- [ ] **Step 1: Create `src/components/builder/delivery-tax-field.tsx`**

```tsx
"use client";

import { useState } from "react";
import { AutosaveIndicator } from "@/components/builder/autosave-indicator";
import { ReadOnlyValue, fieldInputClass } from "@/components/ui-kit";
import { useAutosave } from "@/lib/use-autosave";
import { cn } from "@/lib/utils";
import { setDocumentTax, setIncoterm } from "@/lib/actions/documents";
import { countryName } from "@/lib/countries";
import {
  INCOTERMS,
  INCOTERM_LABELS,
  type Incoterm,
  type TaxSuggestion,
  type TaxTreatment,
} from "@/lib/documents/tax-rules";
import { taxBannerNote } from "@/lib/documents/tax-print";

type Mode = "AUTO" | "CUSTOM";

function rateText(rate: string): string {
  return String(Number(rate));
}

function suggestionLabel(s: TaxSuggestion): string {
  switch (s.treatment) {
    case "EXPORT":
      return `Export — no ${s.taxName} (0%)`;
    case "REVERSE_CHARGE":
      return `Reverse charge — no ${s.taxName} (0%)`;
    case "STANDARD":
      return `${s.taxName} ${rateText(s.taxRate)}%`;
  }
}

function place(code: string | null): string {
  if (!code) return "delivery country not set";
  return countryName(code) ?? code;
}

/**
 * The builder's "Delivery & tax" card (Setup tab): the Incoterm, the route
 * it applies to, and the tax — Auto (the app's suggestion, with its reason)
 * or Custom (the salesperson's own name, rate and reason). Both halves
 * autosave like every neighbouring field; the tax half saves one JSON
 * payload so the three custom inputs travel together.
 *
 * Decisions: Vadym, 2026-09-30 — docs/superpowers/specs/2026-09-30-tax-and-incoterms-design.md.
 */
export function DeliveryTaxField({
  documentId,
  incoterm: initialIncoterm,
  taxTreatment,
  taxName,
  taxRate,
  taxOverridden,
  taxNote,
  suggestion,
  blocker,
  sellerCountry,
  destinationCountry,
  readOnly = false,
}: {
  documentId: string;
  incoterm: Incoterm;
  taxTreatment: TaxTreatment;
  taxName: string;
  taxRate: string;
  taxOverridden: boolean;
  taxNote: string | null;
  suggestion: TaxSuggestion;
  blocker: string | null;
  sellerCountry: string;
  destinationCountry: string | null;
  readOnly?: boolean;
}) {
  const [incoterm, setIncotermValue] = useState<Incoterm>(initialIncoterm);
  const [mode, setMode] = useState<Mode>(taxOverridden ? "CUSTOM" : "AUTO");
  const [customName, setCustomName] = useState(taxOverridden ? taxName : suggestion.taxName);
  const [customRate, setCustomRate] = useState(taxOverridden ? rateText(taxRate) : rateText(suggestion.taxRate));
  const [customNote, setCustomNote] = useState(taxNote ?? "");

  const incotermSave = useAutosave({
    value: incoterm,
    enabled: !readOnly,
    onSave: async (next) => {
      const formData = new FormData();
      formData.set("incoterm", next);
      return setIncoterm(documentId, formData);
    },
  });

  // A string, not an object: useAutosave compares with ===.
  const taxPayload =
    mode === "AUTO"
      ? JSON.stringify({ mode })
      : JSON.stringify({ mode, taxName: customName, taxRate: customRate, taxNote: customNote });

  const taxSave = useAutosave({
    value: taxPayload,
    enabled: !readOnly,
    onSave: async (payload) => {
      const formData = new FormData();
      for (const [key, value] of Object.entries(JSON.parse(payload) as Record<string, string>)) {
        formData.set(key, value);
      }
      return setDocumentTax(documentId, formData);
    },
  });

  if (readOnly) {
    const line = taxBannerNote({ incoterm, taxTreatment, taxName, taxRate, customerTaxId: null }).slice(1, -1);
    return <ReadOnlyValue>{line}.</ReadOnlyValue>;
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <label htmlFor="incoterm" className="text-xs font-medium text-slate-500">
          Incoterm
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <select
            id="incoterm"
            value={incoterm}
            onChange={(e) => setIncotermValue(e.target.value as Incoterm)}
            className={cn(fieldInputClass, "h-11 w-auto sm:h-10")}
          >
            {INCOTERMS.map((code) => (
              <option key={code} value={code}>
                {code} — {INCOTERM_LABELS[code]}
              </option>
            ))}
          </select>
          <AutosaveIndicator status={incotermSave.status} error={incotermSave.error} />
        </div>
        <p className="text-xs text-slate-500">
          Route: {place(sellerCountry)} → {place(destinationCountry)} <span className="text-slate-400">(from client)</span>
        </p>
      </div>

      <fieldset className="flex flex-col gap-2">
        <legend className="mb-1 flex items-center gap-2 text-xs font-medium text-slate-500">
          Tax <AutosaveIndicator status={taxSave.status} error={taxSave.error} />
        </legend>

        <label className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name="tax-mode"
            value="AUTO"
            checked={mode === "AUTO"}
            onChange={() => setMode("AUTO")}
            className="mt-1"
          />
          <span className="flex flex-col">
            <span>
              Auto <span className="font-medium text-slate-800">{suggestionLabel(suggestion)}</span>
            </span>
            <span className="text-xs text-slate-500">{suggestion.reason}</span>
            {suggestion.hint ? <span className="text-xs text-slate-500">{suggestion.hint}</span> : null}
          </span>
        </label>

        <label className="flex items-start gap-2 text-sm">
          <input
            type="radio"
            name="tax-mode"
            value="CUSTOM"
            checked={mode === "CUSTOM"}
            onChange={() => setMode("CUSTOM")}
            className="mt-1"
          />
          <span>Custom</span>
        </label>

        {mode === "CUSTOM" ? (
          <div className="ml-6 flex flex-col gap-2">
            <div className="flex flex-wrap gap-2">
              <label className="flex flex-col gap-1 text-xs text-slate-500">
                Name
                <input
                  value={customName}
                  onChange={(e) => setCustomName(e.target.value)}
                  maxLength={40}
                  placeholder="Sales Tax (Texas)"
                  className={cn(fieldInputClass, "h-10 w-56")}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs text-slate-500">
                Rate %
                <input
                  value={customRate}
                  onChange={(e) => setCustomRate(e.target.value)}
                  inputMode="decimal"
                  className={cn(fieldInputClass, "h-10 w-24")}
                />
              </label>
            </div>
            <label className="flex flex-col gap-1 text-xs text-slate-500">
              Reason (internal, required to finalize)
              <input
                value={customNote}
                onChange={(e) => setCustomNote(e.target.value)}
                maxLength={200}
                placeholder="Delivered to Austin, TX"
                className={cn(fieldInputClass, "h-10")}
              />
            </label>
            <p className="text-xs text-slate-500">Auto would charge: {suggestionLabel(suggestion)}</p>
          </div>
        ) : null}
      </fieldset>

      {blocker ? (
        <p role="alert" className="text-xs font-medium text-amber-700">
          {blocker}
        </p>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 2: Swap the card on the quote page**

In `src/app/(app)/quotes/[documentId]/page.tsx`:

- Replace `import { DeliveryTermsField } from "@/components/builder/delivery-terms-field";` with `import { DeliveryTaxField } from "@/components/builder/delivery-tax-field";`.
- Replace the comment above the card, the `<SectionCard title="Delivery terms" ...>` and its `<DeliveryTermsField .../>` with:

```tsx
            {/* Incoterm + tax for this quote. The app suggests the tax from
                the seller's and the client's countries; the salesperson may
                replace it with a Custom tax and a reason (Vadym, 2026-09-30). */}
            <SectionCard title="Delivery & tax" icon={<Truck className="size-5" />}>
              <DeliveryTaxField
                documentId={document.id}
                incoterm={document.incoterm}
                taxTreatment={document.taxTreatment}
                taxName={document.taxName}
                taxRate={document.taxRate}
                taxOverridden={document.taxOverridden}
                taxNote={document.taxNote}
                suggestion={document.taxSuggestion}
                blocker={document.taxBlocker}
                sellerCountry={document.sellerCountry}
                destinationCountry={document.destinationCountry}
                readOnly={!isDraft}
              />
            </SectionCard>
```

- In `quoteReadiness({...})` add `taxBlocker: document.taxBlocker,` after `pathWorksModulesWithoutHost: ...`.
- In `<DocumentTotals ... />` (right column, ~line 582) add:

```tsx
                    taxOverridden={document.taxOverridden}
                    taxNote={document.taxNote}
```

- [ ] **Step 3: "custom" badge in `DocumentTotals`**

In `src/components/builder/sticky-footer.tsx`, add to `TotalsProps`:

```ts
  /** A salesperson's custom tax: shown as a "custom" badge beside the tax
   * line, with the reason as its tooltip. Only the people who can open the
   * builder see it (author, Regional manager, Admin, Developer). */
  taxOverridden?: boolean;
  taxNote?: string | null;
```

destructure them in `DocumentTotals`, and change the tax `<dt>` to:

```tsx
        <dt className="text-slate-500">
          {taxName} ({taxRate}%)
          {taxOverridden ? (
            <span
              title={taxNote ?? "No reason given yet"}
              className="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-medium uppercase text-amber-800"
            >
              custom
            </span>
          ) : null}
        </dt>
```

- [ ] **Step 4: Delete the old field and fix the comment**

```bash
git rm src/components/builder/delivery-terms-field.tsx
```

In `src/components/ui-kit/read-only-value.tsx`, change the comment's `DeliveryTermsField to "Delivered."` to `DeliveryTaxField to its one-line summary`.

- [ ] **Step 5: Static checks**

Run: `grep -rn "DeliveryTermsField\|deliveryTerms\|EX_WORKS\|DELIVERED" src tests`
Expected: no hits.

Run: `npx eslint src/components/builder src/app/\(app\)/quotes && npx vitest run`
Expected: clean, PASS.

- [ ] **Step 6: Manual check (Vadym's Mac, after `npx prisma migrate dev` + `npm run dev`)**

On a draft for an Australian client:
1. Setup tab → "Delivery & tax": Incoterm `DAP`, route "Australia → Australia", Auto "GST 10%".
2. Switch Incoterm to `EXW`: Auto still "GST 10%" (domestic EXW is taxed).
3. Change the client's delivery country to New Zealand on the client's page (needs Task 13): Auto becomes "Export — no GST (0%)", Summary tax 0, printed banner "(EXW, export — no GST)".
4. Set Incoterm `DDP`: amber "DDP abroad: set New Zealand's tax with Custom", readiness panel shows "Delivery & tax", Finalize refuses.
5. Choose Custom, name "NZ GST", rate 15, reason empty: still blocked ("Give a reason for the custom tax"). Type a reason: Finalize allowed; Summary shows the "custom" badge with the reason on hover.
6. Back to Auto: the custom figures disappear, the suggestion returns.

- [ ] **Step 7: Commit**

```bash
git add src/components/builder src/components/ui-kit/read-only-value.tsx "src/app/(app)/quotes/[documentId]/page.tsx"
git commit -m "feat(tax): Delivery & tax card on the quote Setup tab"
```

### Task 13: Client changes re-price open drafts

The suggestion depends on the client's country, delivery country and VAT ID. Those live on `Company`, and today neither choosing a company for a quote nor editing a company recalculates anything. Without this task, the card would show "Export" while the stored totals still carry GST until some unrelated edit.

**Files:**
- Modify: `src/lib/actions/documents/lifecycle.ts` (`setDocumentClient`, ~line 343)
- Modify: `src/lib/actions/clients.ts` (`updateCompany`, ~line 150)

- [ ] **Step 1: `setDocumentClient` recalculates**

In `lifecycle.ts`, add `import { recalcDocument } from "@/lib/documents/recalc";` and, directly after `if (updated.count !== 1) return { error: NOT_FOUND_ERROR };`, add:

```ts
  // The client decides the destination country and VAT ID the tax
  // suggestion reads (src/lib/documents/tax-rules.ts), so a new client can
  // move the tax. Pre-tax totals are unaffected, so no cap can trip here.
  await recalcDocument(document.id);
```

- [ ] **Step 2: `updateCompany` recalculates the company's drafts**

In `clients.ts`, add imports:

```ts
import { recalcDocument } from "@/lib/documents/recalc";
import { revalidateDocument } from "@/lib/revalidate";
```

(merge `revalidateDocument` into the existing `@/lib/revalidate` import), and after the `db.company.update(...)` call, before `revalidateCompanyList();`, add:

```ts
  // Country, delivery country and VAT ID drive every open quote's suggested
  // tax. FINAL quotes are frozen and skipped by the status filter; a draft
  // with a Custom tax is recalculated but keeps its figures (tax.ts).
  const drafts = await db.document.findMany({
    where: { companyId, status: "DRAFT" },
    select: { id: true },
  });
  for (const draft of drafts) {
    await recalcDocument(draft.id);
    revalidateDocument(draft.id);
  }
```

- [ ] **Step 3: Verify**

Run: `npx eslint src/lib/actions && npx vitest run`
Expected: clean, PASS.

Manual (Vadym's Mac): in a draft for an Australian client, open the client's page (`/clients/<id>`), set the delivery country to New Zealand and save, then return to the quote. The Summary's tax must be 0 without any edit to the quote itself. Also: create a new NZ client inline from the builder's client step; the tax must switch to Export as soon as it is selected.

- [ ] **Step 4: Commit**

```bash
git add src/lib/actions/documents/lifecycle.ts src/lib/actions/clients.ts
git commit -m "feat(tax): changing a quote's client or the client's countries re-prices open drafts"
```

### Task 14: Region settings — Country field

**Files:**
- Modify: `src/lib/queries/regions.ts` (`RegionAdminDetail` type and `getRegionAdmin`, ~line 84)
- Modify: `src/lib/actions/regions.ts` (`readRegionForm` ~26, `createRegion` data ~81, `updateRegion` data ~141)
- Modify: `src/components/regions/region-form.tsx` (`RegionFormValues` ~11, a new field after Name)
- Modify: `src/app/(app)/settings/regions/new/page.tsx`, `src/app/(app)/settings/regions/[regionId]/page.tsx` (`defaultValues`)

- [ ] **Step 1: Query**

In `src/lib/queries/regions.ts`, add `country: string;` to `RegionAdminDetail` after `name`, and `country: region.country,` to the object `getRegionAdmin` returns.

- [ ] **Step 2: Actions**

In `src/lib/actions/regions.ts`:
- `readRegionForm`: add `country: formData.get("country"),` after `name`.
- In both the `create` data (~line 81) and the `update` data (~line 141), add `country: parsed.data.country,` after `name`.

- [ ] **Step 3: Form**

In `src/components/regions/region-form.tsx`:
- `RegionFormValues`: add `country: string;` after `name`.
- Add `CountrySelect` to the `@/components/ui-kit` import.
- Right after the Name `FieldRow`, add:

```tsx
          <FieldRow
            label="Country"
            htmlFor="region-country"
            required
            hint="Where this region's legal entity sells from. Drives the tax suggested on quotes (the UK is United Kingdom, GB)."
          >
            <CountrySelect
              id="region-country"
              name="country"
              value={values.country}
              onChange={(country) => set("country", country)}
              required
            />
          </FieldRow>
```

Check the `CountrySelect` props at `src/components/ui-kit/country-select.tsx:20` if this does not type-check: it takes `id`, `name`, `value`, `onChange(value: string)`, `required`.

- [ ] **Step 4: Pages**

- `new/page.tsx`: add `country: "",` after `name: "",` in `defaultValues`.
- `[regionId]/page.tsx`: add `country: region.country,` after `name: region.name,`.

- [ ] **Step 5: Verify**

Run: `npx eslint src/components/regions src/lib/actions/regions.ts src/lib/queries/regions.ts "src/app/(app)/settings/regions" && npx vitest run tests/regions-validation.test.ts`
Expected: clean, PASS.

- [ ] **Step 6: Commit**

```bash
git add src/lib/queries/regions.ts src/lib/actions/regions.ts src/components/regions/region-form.tsx "src/app/(app)/settings/regions"
git commit -m "feat(tax): region settings record the selling entity's country"
```

### Task 15: Full verification and the spec touch-up

**Files:**
- Modify: `docs/superpowers/specs/2026-09-30-tax-and-incoterms-design.md` (Migration step 4)

- [ ] **Step 1: Nothing of the old model is left**

Run: `grep -rn "deliveryTerms\|DeliveryTerms\|EX_WORKS\|engineTaxRate\|setDeliveryTerms" src tests prisma/schema.prisma prisma/seed*.ts`
Expected: no output. (`prisma/migrations/z14_*` and `z59_*` legitimately mention them. Do not edit old migrations.)

- [ ] **Step 2: Test and lint**

Run: `npx vitest run`
Expected: all test files PASS.

Run: `npx eslint`
Expected: no errors.

- [ ] **Step 3: Type check with the known sandbox caveat**

Run: `npx tsc --noEmit > /tmp/tsc.txt 2>&1; grep -c "error TS" /tmp/tsc.txt; grep "error TS" /tmp/tsc.txt | grep -v -E "incoterm|taxTreatment|taxOverridden|taxNote|country|Incoterm|TaxTreatment" | head -20`
Expected: only errors about the new Prisma columns and enums (stale generated client). Any other error is real and must be fixed. On Vadym's Mac after `npx prisma generate`, `npm run typecheck` must be clean.

- [ ] **Step 4: Correct the spec's migration step 4**

In the spec's "Migration" section, replace step 4 with:

```markdown
4. Stored revision snapshots are left untouched. `REVISION_SNAPSHOT_VERSION`
   becomes 2 (`incoterm` + `taxTreatment` replace `deliveryTerms`). The first
   re-finalize of a quote finalized before this deploy mints one extra `-R`
   revision even if nothing changed. Accepted: only a handful of quotes exist.
```

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-09-30-tax-and-incoterms-design.md
git commit -m "docs(spec): revision snapshots are versioned, not rewritten"
```

### Task 16: Release — Vadym runs these (production is live)

Pushing to `main` deploys **and runs `prisma migrate deploy` on the VPS automatically** (`docs/runbook.md` §2b). So everything below happens **before** `git push`.

- [ ] **Step 1: Local database**

On the Mac: `npx prisma migrate dev` (applies z59 and regenerates the client), then `npm run typecheck`, `npx vitest run`, `npm run dev`, and walk through Task 12 Step 6 and Task 13 Step 3.

- [ ] **Step 2: Preview on production (read-only)**

On the VPS, run `scripts/sql/tax-migration-preview.sql` with the same `psql` access the runbook uses for the database. Review the listed drafts: these are the ones whose total will change on their next edit. Legacy free-text countries may appear as false positives.

- [ ] **Step 3: Backup immediately before deploy**

On the VPS: `systemctl start pq-backup-db.service && tail -n 3 /var/log/pq-backup.log`
Expected: a fresh `db backup ok: ...` line.

- [ ] **Step 4: Deploy**

`git push origin main`, then watch the GitHub Actions run to green.

- [ ] **Step 5: After deploy**

1. Settings → Regions: every region shows the right Country (AU, US, GB, …). Fix any region whose code is not an ISO country.
2. Open one finalized quote from before the deploy: totals and PDF are unchanged, except that an Ex Works quote's banner now reads "(EXW, export — no GST)".
3. Open one draft from the preview list and check that its tax now follows the rules.
