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
 * Every BLOCKING row mirrors a rule `validateFinalizable` actually enforces,
 * one for one. That constraint is the whole value of the panel: a row that
 * blocks something the server would have allowed is just as wrong as a row
 * that passes something the server refuses, and it is worse in practice,
 * because the user has no way to satisfy it. The first draft of this file
 * invented an "every item must have a price" rule and promptly reported a
 * real EasyLoader, which is built entirely out of options and has no base
 * price, and then a deliberately free SERVICE line, as blockers.
 *
 * Pure on purpose: no React, no Prisma client, no money formatting. The caller
 * passes a summary of what it already has in hand and gets rows back.
 */
export type ReadinessKey = "client" | "items" | "spec" | "delivery" | "documents" | "pathworks";

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
   * The documents and PathWorks rows are advisory.
   */
  blocking: boolean;
};

export type ReadinessInput = {
  hasCompany: boolean;
  /** Whether a contact is selected. Not a finalize rule -- `validateFinalizable`
   *  never looks at it -- but a quote with no contact cannot be emailed, so
   *  the client row says so without blocking. */
  hasContact: boolean;
  items: Array<ReadinessItem & { id: string }>;
  /** Document-level extra lines (delivery, install, training). A quote with
   *  no machines but an extra line is finalizable -- see
   *  `validateFinalizable`'s `hasDocumentLevelLines`. */
  extraLineCount: number;
  /** The chosen terms. Never absent, which is why its row is informational
   *  rather than a blocker: see `deliveryRow`. */
  deliveryTerms: "DELIVERED" | "EX_WORKS";
  /** How many legal documents this quote will print. */
  printedDocumentCount: number;
  /** Over the region's discount cap. A hard stop, deliberately not a row. */
  capExceeded: boolean;
  /** Over the region's markup ceiling. Same. */
  exceedsMarkupCap: boolean;
  /** PathWorks modules on the quote with no licence to host them -- see
   *  `pathWorksModulesWithoutHost`. Computed by the caller, which has the
   *  product specs; this module stays free of that dependency. */
  pathWorksModulesWithoutHost: boolean;
};

export function quoteReadiness(input: ReadinessInput): ReadinessRow[] {
  return [
    clientRow(input),
    itemsRow(input),
    specRow(input),
    deliveryRow(input),
    documentsRow(input),
    // Last, and only when there is something to say. Every other row is
    // always present because its absence would itself be information ("is
    // the client set? the panel does not say"); this one is a remark about
    // an unusual combination, and a permanent "PathWorks — fine" line would
    // be noise on the great majority of quotes that carry no modules at all.
    ...(input.pathWorksModulesWithoutHost ? [pathWorksRow()] : []),
  ];
}

/**
 * Modules with no licence to run in. Advisory, not a blocker: the customer
 * may already own PathWorks, in which case nothing is wrong. It exists here
 * because the only place this was ever said was the order forms, which
 * appear after finalisation -- the one moment it is too late to ask.
 */
function pathWorksRow(): ReadinessRow {
  return {
    key: "pathworks",
    label: "PathWorks licence",
    met: false,
    detail: "Modules on this quote with no licence to host them — fine if the client already owns one",
    targetTab: "build",
    targetItemId: null,
    blocking: false,
  };
}

function clientRow(input: ReadinessInput): ReadinessRow {
  // `validateFinalizable` checks `companyId` and nothing else here, so the
  // company is what blocks. A missing contact is reported in the same row
  // because it stops the quote being sent later, not finalized now.
  return {
    key: "client",
    label: "Client",
    met: input.hasCompany,
    detail: !input.hasCompany
      ? "No company selected"
      : input.hasContact
        ? null
        : "No contact yet. One is needed to send the quote.",
    targetTab: "build",
    targetItemId: null,
    blocking: true,
  };
}

function itemsRow(input: ReadinessInput): ReadinessRow {
  // Mirrors `items.length === 0 && !hasDocumentLevelLines`. Deliberately no
  // price check: an EasyLoader carries its whole price in its options and
  // has none of its own, and a SERVICE line is sometimes free on purpose.
  // "items", not "machines": a quote carries software, accessories, service
  // and spare parts alongside the cutters, and calling the lot machines is
  // wrong on most real quotes.
  const count = input.items.length;
  const hasAnything = count > 0 || input.extraLineCount > 0;
  return {
    key: "items",
    label:
      count === 0 ? "Something to quote" : count === 1 ? "1 item" : `${count} items`,
    met: hasAnything,
    detail: hasAnything
      ? input.extraLineCount > 0
        ? `plus ${input.extraLineCount} extra ${input.extraLineCount === 1 ? "line" : "lines"}`
        : null
      : "Nothing on this quote yet",
    targetTab: "build",
    targetItemId: null,
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
        : `${incomplete.length} items incomplete, starting with ${incomplete[0].item.code}`;

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
  const exWorks = input.deliveryTerms === "EX_WORKS";
  return {
    key: "delivery",
    label: "Delivery terms",
    // Always met, because `Document.deliveryTerms` is an enum that defaults
    // to DELIVERED and can never be empty. It is a row anyway, and an
    // informational one rather than a fake blocker, because Ex Works quietly
    // zeroes the tax on the whole quote and that is worth stating in the one
    // place someone checks before finalizing.
    met: true,
    detail: exWorks ? "Ex Works, no GST charged" : "Delivered, GST applies",
    targetTab: "terms",
    targetItemId: null,
    blocking: false,
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
