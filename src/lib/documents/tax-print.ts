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
