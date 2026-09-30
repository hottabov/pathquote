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
 *
 * The main country is a fallback only for a BLANK delivery country. A
 * delivery country that is filled in but not recognised ("Nueva Zelanda")
 * yields null, so the "Set the client's delivery country" blocker fires
 * instead of the quote silently taking the main country's tax.
 */
export function destinationCountry(
  company: { country: string | null; deliverySameAsMain: boolean; deliveryCountry: string | null } | null
): string | null {
  if (!company) return null;
  if (!company.deliverySameAsMain && company.deliveryCountry?.trim()) {
    return normalizeCountryInput(company.deliveryCountry);
  }
  return normalizeCountryInput(company.country);
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
