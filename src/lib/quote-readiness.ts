import {
  describeIssues,
  productionIssues,
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
 * Every refusal `finalizeDocument` can return is a row here -- the region
 * caps and per-item discount limits included. They used to live outside the
 * list (a separate badge, a separate prop on the Finalize button), which is
 * how a per-item discount over the limit ended up shown nowhere at all: the
 * button stayed live and the refusal only arrived as a toast after the click.
 *
 * Pure on purpose: no React, no Prisma client, no money formatting. The caller
 * passes a summary of what it already has in hand -- the cap messages already
 * formatted -- and gets rows back.
 */
export type ReadinessKey =
  | "client"
  | "items"
  | "spec"
  | "itemDiscount"
  | "discountCap"
  | "markupCap"
  | "tax"
  | "documents"
  | "pathworks";

export type ReadinessRow = {
  key: ReadinessKey;
  /** The row's own heading, e.g. "3 machines priced". */
  label: string;
  met: boolean;
  /** One short line naming what is missing, or null when the row is met. */
  detail: string | null;
  /**
   * False for an advisory row: counted nowhere, never blocks Finalize. The
   * documents and PathWorks rows are advisory.
   */
  blocking: boolean;
  /**
   * Whether this row is worth the reader's attention right now -- which is
   * what decides whether it is drawn at all, and whether the panel exists.
   *
   * Deliberately not the same thing as `!met`. `met` mirrors
   * `validateFinalizable` and drives the count, so it has to stay exactly as
   * strict as the server: the client row is met once a company is chosen,
   * because that is all finalising requires. But a quote with a company and
   * no contact cannot be *sent*, and that is worth saying, so the row still
   * asks to be seen.
   */
  needsAttention: boolean;
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
  /** How many legal documents this quote will print. */
  printedDocumentCount: number;
  /** Items whose own discount is above the region's limit -- the engine's
   *  per-item `violations`, which `validateFinalizable` refuses on. */
  discountViolations: Array<{ code: string; allowedPct: number }>;
  /** `concessionCapMessage(...)` while the whole quote's concession is over
   *  the region's discount cap, else null. */
  discountCapMessage: string | null;
  /** `markupCapMessage(...)` while the quote is priced above the region's
   *  markup ceiling, else null. */
  markupCapMessage: string | null;
  /** PathWorks modules on the quote with no licence to host them -- see
   *  `pathWorksModulesWithoutHost`. Computed by the caller, which has the
   *  product specs; this module stays free of that dependency. */
  pathWorksModulesWithoutHost: boolean;
  /** `RecalcResult.taxBlocker` / `DocumentForBuilder.taxBlocker` — why the
   *  quote's tax cannot be finalized, or null. Mirrors the refusal in
   *  `finalizeDocument` one for one. */
  taxBlocker: string | null;
};

export function quoteReadiness(input: ReadinessInput): ReadinessRow[] {
  return [
    clientRow(input),
    itemsRow(input),
    specRow(input),
    // The limits and the tax appear only while they refuse Finalize: a
    // permanent "discount within limit" line would be noise on every quote.
    ...(input.discountViolations.length > 0 ? [itemDiscountRow(input.discountViolations)] : []),
    ...(input.discountCapMessage ? [limitRow("discountCap", "Discount limit", input.discountCapMessage)] : []),
    ...(input.markupCapMessage ? [limitRow("markupCap", "Price ceiling", input.markupCapMessage)] : []),
    // Shown with or without a company. It used to wait for one, on the
    // grounds that "set the delivery country" repeats the client row -- but
    // the same gate also hid "give a reason for the custom tax", which has
    // nothing to do with the client.
    ...(input.taxBlocker ? [taxRow(input.taxBlocker)] : []),
    documentsRow(input),
    // Last, and only when there is something to say. The four standing rows
    // are always present because its absence would itself be information ("is
    // the client set? the panel does not say"); this one is a remark about
    // an unusual combination, and a permanent "PathWorks — fine" line would
    // be noise on the great majority of quotes that carry no modules at all.
    ...(input.pathWorksModulesWithoutHost ? [pathWorksRow()] : []),
  ];
}

/** Per-item discounts over the region's limit. Named by item code, which is
 *  what the reader sees on the Build tab -- not the server's "item 2". */
function itemDiscountRow(violations: ReadinessInput["discountViolations"]): ReadinessRow {
  return {
    key: "itemDiscount",
    label: "Item discount",
    met: false,
    needsAttention: true,
    detail: violations.map((v) => `${v.code}: above the ${v.allowedPct}% limit`).join("; "),
    blocking: true,
  };
}

/** The region's whole-quote discount cap or markup ceiling. Not something
 *  the user completes, a limit they come back under -- but it refuses
 *  Finalize like any other row, so it is said in the same list. */
function limitRow(key: "discountCap" | "markupCap", label: string, message: string): ReadinessRow {
  return { key, label, met: false, needsAttention: true, detail: message, blocking: true };
}

function taxRow(blocker: string): ReadinessRow {
  return {
    key: "tax",
    label: "Delivery & tax",
    met: false,
    needsAttention: true,
    detail: blocker,
    blocking: true,
  };
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
    needsAttention: true,
    detail: "Modules on this quote with no licence to host them — fine if the client already owns one",
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
    // A missing contact does not block Finalize but is still worth a look:
    // the quote cannot be emailed without one.
    needsAttention: !input.hasCompany || !input.hasContact,
    detail: !input.hasCompany
      ? "No company selected"
      : input.hasContact
        ? null
        : "No contact yet. One is needed to send the quote.",
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
    needsAttention: !hasAnything,
    detail: hasAnything
      ? input.extraLineCount > 0
        ? `plus ${input.extraLineCount} extra ${input.extraLineCount === 1 ? "line" : "lines"}`
        : null
      : "Nothing on this quote yet",
    blocking: true,
  };
}

function specRow(input: ReadinessInput): ReadinessRow {
  // The same `productionIssues`/`describeIssues` pair `finalizeDocument`
  // refuses with, so the row and the server name the same items in the same
  // words. Every incomplete item is listed: the row is the only pointer the
  // reader gets to which ones need filling in.
  const issues = productionIssues(input.items);
  return {
    key: "spec",
    label: "Production spec",
    met: issues.length === 0,
    needsAttention: issues.length > 0,
    detail: issues.length === 0 ? null : describeIssues(issues),
    blocking: true,
  };
}

function documentsRow(input: ReadinessInput): ReadinessRow {
  const count = input.printedDocumentCount;
  return {
    key: "documents",
    label: "Legal documents",
    met: count > 0,
    needsAttention: count === 0,
    detail: count > 0 ? `${count} will print` : "None will print",
    // Advisory. A quote that prints no legal documents is unusual but
    // `finalizeDocument` does not refuse it, so neither does this. Showing it
    // anyway is the point: it is exactly the omission nobody notices until
    // the customer does.
    blocking: false,
  };
}

/**
 * The rows that refuse Finalize right now. The button is disabled while this
 * is non-empty, and it reads the same rows the Summary panel draws, so the
 * two cannot disagree.
 */
export function unmetBlockers(rows: ReadinessRow[]): ReadinessRow[] {
  return rows.filter((row) => row.blocking && !row.met);
}
