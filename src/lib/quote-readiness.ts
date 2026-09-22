import {
  itemMissing,
  REQUIREMENT_LABELS,
  type ReadinessItem,
} from "@/lib/production-forms/readiness";

/**
 * What still stands between this quote and Finalize, as an ordered list the
 * builder's rail renders directly.
 *
 * This exists because the answer used to be derived in two places and was
 * about to be derived in a third: inline in the quote page, where it fed
 * FinalizeButton two ad-hoc strings, and again server-side in
 * `finalizeDocument`. Two derivations of the same rule eventually disagree,
 * and the one that disagrees visibly is the one the user is reading, so the
 * screen would confidently say "ready" while the action refused.
 *
 * `productionIssues` already solved exactly this for the production-form half
 * of the question (see its own doc comment); this is the same idea widened to
 * the whole quote, and it calls into that function rather than repeating it.
 *
 * Pure on purpose: no React, no Prisma client, no money formatting. The caller
 * passes a summary of what it already has in hand and gets rows back.
 */
export type ReadinessKey = "client" | "items" | "spec" | "delivery" | "documents";

export type ReadinessRow = {
  key: ReadinessKey;
  /** The row's own heading, e.g. "3 machines priced". */
  label: string;
  met: boolean;
  /** One short line naming what is missing, or null when the row is met. */
  detail: string | null;
  /** Which builder tab the fix lives on, so the panel can link to it. */
  targetTab: "build" | "terms";
  /** The machine to expand and scroll to, when the fix is inside one. */
  targetItemId: string | null;
  /**
   * False for an advisory row: shown, counted nowhere, never blocks Finalize.
   * Only the documents row is advisory today.
   */
  blocking: boolean;
};

export type ReadinessInput = {
  hasCompany: boolean;
  hasContact: boolean;
  items: Array<ReadinessItem & { id: string; unitPriceCents: number }>;
  deliveryTermsSet: boolean;
  /** How many legal documents this quote will print. */
  printedDocumentCount: number;
  /** Over the region's discount cap. A hard stop, deliberately not a row. */
  capExceeded: boolean;
  /** Over the region's markup ceiling. Same. */
  exceedsMarkupCap: boolean;
};

export function quoteReadiness(input: ReadinessInput): ReadinessRow[] {
  return [clientRow(input), itemsRow(input), specRow(input), deliveryRow(input), documentsRow(input)];
}

function clientRow(input: ReadinessInput): ReadinessRow {
  const detail = !input.hasCompany
    ? "No company selected"
    : !input.hasContact
      ? "No contact selected"
      : null;
  return {
    key: "client",
    label: "Client and contact",
    met: detail === null,
    detail,
    targetTab: "build",
    targetItemId: null,
    blocking: true,
  };
}

function itemsRow(input: ReadinessInput): ReadinessRow {
  const unpriced = input.items.find((item) => item.unitPriceCents <= 0);
  const detail =
    input.items.length === 0
      ? "No machines yet"
      : unpriced
        ? `${unpriced.code} has no price`
        : null;
  return {
    key: "items",
    label:
      input.items.length === 0
        ? "Machines priced"
        : input.items.length === 1
          ? "1 machine priced"
          : `${input.items.length} machines priced`,
    met: detail === null,
    detail,
    targetTab: "build",
    targetItemId: unpriced?.id ?? null,
    blocking: true,
  };
}

function specRow(input: ReadinessInput): ReadinessRow {
  // `itemMissing` is the per-item check `finalizeDocument` enforces through
  // `productionIssues`. Calling it here is what keeps the rail and the server
  // from drifting apart.
  const incomplete = input.items
    .map((item) => ({ item, missing: itemMissing(item) }))
    .filter((entry) => entry.missing.length > 0);

  const detail =
    incomplete.length === 0
      ? null
      : incomplete.length === 1
        ? `${incomplete[0].item.code}: ${describeMissing(incomplete[0].missing)}`
        : `${incomplete.length} machines incomplete, starting with ${incomplete[0].item.code}`;

  return {
    key: "spec",
    label: "Production spec",
    met: incomplete.length === 0,
    detail,
    targetTab: "build",
    targetItemId: incomplete[0]?.item.id ?? null,
    blocking: true,
  };
}

function deliveryRow(input: ReadinessInput): ReadinessRow {
  return {
    key: "delivery",
    label: "Delivery terms",
    met: input.deliveryTermsSet,
    detail: input.deliveryTermsSet ? null : "Not chosen",
    targetTab: "terms",
    targetItemId: null,
    blocking: true,
  };
}

function documentsRow(input: ReadinessInput): ReadinessRow {
  const count = input.printedDocumentCount;
  return {
    key: "documents",
    label: "Legal documents",
    met: count > 0,
    detail: count > 0 ? `${count} will print` : "None will print",
    targetTab: "terms",
    targetItemId: null,
    // Advisory. A quote that prints no legal documents is unusual but
    // `finalizeDocument` does not refuse it, so neither does this. Showing it
    // anyway is the point: it is exactly the omission nobody notices until
    // the customer does.
    blocking: false,
  };
}

/** "knife size, MTS travel (m)" -- the same labels the finalize error uses. */
function describeMissing(missing: string[]): string {
  return missing.map((key) => REQUIREMENT_LABELS[key] ?? key).join(", ");
}

/**
 * The single verdict Finalize is gated on, so the button and the rail cannot
 * disagree. The cap checks are not rows because they are not something the
 * user completes; they are a limit they have to come back under.
 */
export function isFinalizable(input: ReadinessInput): boolean {
  if (input.capExceeded || input.exceedsMarkupCap) return false;
  return quoteReadiness(input).every((row) => !row.blocking || row.met);
}
