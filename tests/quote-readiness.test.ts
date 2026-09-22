import { describe, it, expect } from "vitest";
import {
  isFinalizable,
  quoteReadiness,
  readinessNeedsAttention,
  type ReadinessInput,
} from "../src/lib/quote-readiness";

// Pure module: no Prisma client, no DATABASE_URL, same discipline as
// tests/production-readiness.test.ts, which covers the per-item check this
// one wraps.

const COMPLETE_SPEC = { knifeSize: "1.5x7.0" };

function item(over: Partial<ReadinessInput["items"][number]> = {}): ReadinessInput["items"][number] {
  return {
    id: "i1",
    code: "M-7220",
    form: "M_SERIES",
    productionSpec: COMPLETE_SPEC,
    options: [],
    ...over,
  };
}

function input(over: Partial<ReadinessInput> = {}): ReadinessInput {
  return {
    hasCompany: true,
    hasContact: true,
    items: [item()],
    extraLineCount: 0,
    deliveryTerms: "DELIVERED",
    printedDocumentCount: 3,
    capExceeded: false,
    exceedsMarkupCap: false,
    pathWorksModulesWithoutHost: false,
    ...over,
  };
}

describe("quoteReadiness", () => {
  it("returns every row even when all of them are met", () => {
    const rows = quoteReadiness(input());
    expect(rows.map((r) => r.key)).toEqual(["client", "items", "spec", "delivery", "documents"]);
    expect(rows.every((r) => r.met)).toBe(true);
    // Returned, but none of them asking to be drawn -- the panel's own
    // visibility is a separate question from what the rules say.
    expect(rows.every((r) => !r.needsAttention)).toBe(true);
  });

  // The rail renders these in order. If the order moved as rows were
  // satisfied, the list would reshuffle under the user's cursor while they
  // were working down it.
  it("keeps the same order whatever is missing", () => {
    const keys = (i: ReadinessInput) => quoteReadiness(i).map((r) => r.key);
    expect(keys(input({ hasContact: false }))).toEqual(keys(input()));
    expect(keys(input({ items: [] }))).toEqual(keys(input()));
  });

  // validateFinalizable checks companyId and nothing else about the client,
  // so a missing contact is reported without blocking: it stops the quote
  // being sent later, not finalized now.
  it("reports a missing contact without blocking on it", () => {
    const row = quoteReadiness(input({ hasContact: false })).find((r) => r.key === "client");
    expect(row?.met).toBe(true);
    expect(row?.detail).toBe("No contact yet. One is needed to send the quote.");
    expect(isFinalizable(input({ hasContact: false }))).toBe(true);
  });

  it("blocks on a missing company", () => {
    const row = quoteReadiness(input({ hasCompany: false, hasContact: false })).find(
      (r) => r.key === "client"
    );
    expect(row?.met).toBe(false);
    expect(row?.detail).toBe("No company selected");
  });

  it("fails the items row on a quote with nothing on it at all", () => {
    const row = quoteReadiness(input({ items: [] })).find((r) => r.key === "items");
    expect(row?.met).toBe(false);
    expect(row?.detail).toBe("Nothing on this quote yet");
    expect(row?.label).toBe("Something to quote");
  });

  // validateFinalizable accepts items OR document-level lines, so a quote
  // that is only delivery and training is finalizable.
  it("accepts a quote with no machines but an extra line", () => {
    const rows = quoteReadiness(input({ items: [], extraLineCount: 1 }));
    expect(rows.find((r) => r.key === "items")?.met).toBe(true);
    expect(isFinalizable(input({ items: [], extraLineCount: 1 }))).toBe(true);
  });

  it("counts the items in the row label, and the extras in its detail", () => {
    expect(quoteReadiness(input()).find((r) => r.key === "items")?.label).toBe("1 item");
    expect(
      quoteReadiness(input({ items: [item(), item({ id: "i2" })] })).find((r) => r.key === "items")
        ?.label
    ).toBe("2 items");
    expect(
      quoteReadiness(input({ extraLineCount: 2 })).find((r) => r.key === "items")?.detail
    ).toBe("plus 2 extra lines");
  });

  // There is deliberately no "every item must have a price" rule. An
  // EasyLoader is built entirely out of options and carries no base price of
  // its own, and a SERVICE line is sometimes free on purpose. An earlier
  // version of this module invented that rule and flagged both, live, on a
  // quote the server would have finalized without complaint.
  it("does not invent a price requirement the server does not enforce", () => {
    const easyLoader = item({ id: "el", code: "EL-3220" });
    const freeService = item({ id: "svc", code: "SERVICE", form: null });
    expect(isFinalizable(input({ items: [easyLoader, freeService] }))).toBe(true);
  });

  it("names the machine and the missing fields on an incomplete production spec", () => {
    const rows = quoteReadiness(input({ items: [item({ productionSpec: {} })] }));
    const row = rows.find((r) => r.key === "spec");
    expect(row?.met).toBe(false);
    expect(row?.detail).toBe("M-7220: knife size");
    expect(row?.targetItemId).toBe("i1");
  });

  it("points at the first incomplete machine when several are", () => {
    const rows = quoteReadiness(
      input({
        items: [
          item({ id: "i1" }),
          item({ id: "i2", code: "M-3220", productionSpec: {} }),
          item({ id: "i3", code: "L-220", productionSpec: {} }),
        ],
      })
    );
    const row = rows.find((r) => r.key === "spec");
    expect(row?.targetItemId).toBe("i2");
    expect(row?.detail).toBe("2 items incomplete, starting with M-3220");
  });

  // `Document.deliveryTerms` is an enum that can never be empty, so a
  // "delivery chosen" blocker would always pass and mean nothing. The row
  // earns its place by saying which terms, because Ex Works zeroes the tax.
  it("reports the delivery terms rather than blocking on them", () => {
    const delivered = quoteReadiness(input()).find((r) => r.key === "delivery");
    expect(delivered?.met).toBe(true);
    expect(delivered?.blocking).toBe(false);
    expect(delivered?.detail).toBe("Delivered, GST applies");

    const exWorks = quoteReadiness(input({ deliveryTerms: "EX_WORKS" })).find((r) => r.key === "delivery");
    expect(exWorks?.detail).toBe("Ex Works — no GST on this quote");
    expect(exWorks?.targetTab).toBe("terms");
  });

  it("asks to be seen on Ex Works and stays quiet on Delivered", () => {
    // The row is always met either way -- deliveryTerms is an enum that
    // cannot be empty -- so `met` cannot decide whether to draw it. Ex Works
    // has quietly zeroed the tax on the whole quote; Delivered is the
    // default and says nothing.
    const delivered = quoteReadiness(input({ deliveryTerms: "DELIVERED" })).find(
      (row) => row.key === "delivery"
    );
    const exWorks = quoteReadiness(input({ deliveryTerms: "EX_WORKS" })).find(
      (row) => row.key === "delivery"
    );
    expect(delivered?.met).toBe(true);
    expect(delivered?.needsAttention).toBe(false);
    expect(exWorks?.met).toBe(true);
    expect(exWorks?.needsAttention).toBe(true);
  });

  it("keeps the client row visible when a company is set but no contact is", () => {
    // `validateFinalizable` checks the company and nothing else, so the row
    // is met and the count says so -- but the quote cannot be emailed
    // without a contact, which is worth saying.
    const row = quoteReadiness(input({ hasCompany: true, hasContact: false })).find(
      (r) => r.key === "client"
    );
    expect(row?.met).toBe(true);
    expect(row?.needsAttention).toBe(true);
    expect(row?.detail).toContain("No contact");
  });

  it("raises the PathWorks row only when there is something to say", () => {
    expect(
      quoteReadiness(input({ pathWorksModulesWithoutHost: false })).some(
        (row) => row.key === "pathworks"
      )
    ).toBe(false);

    const row = quoteReadiness(input({ pathWorksModulesWithoutHost: true })).find(
      (r) => r.key === "pathworks"
    );
    // Advisory: a customer who already owns PathWorks buys modules for it
    // and nothing is wrong, so it must never stand between them and
    // Finalize.
    expect(row?.blocking).toBe(false);
    expect(row?.needsAttention).toBe(true);
    expect(isFinalizable(input({ pathWorksModulesWithoutHost: true }))).toBe(true);
  });
});

describe("readinessNeedsAttention", () => {
  it("is false for a quote with nothing missing, unusual or incompatible", () => {
    expect(readinessNeedsAttention(quoteReadiness(input()))).toBe(false);
  });

  it("is true while a blocking row is unmet", () => {
    expect(readinessNeedsAttention(quoteReadiness(input({ hasCompany: false })))).toBe(true);
  });

  it("is true for an advisory row alone, with every blocking row met", () => {
    // The case the panel exists for once a quote is otherwise finished:
    // nothing is wrong, something is unusual.
    const rows = quoteReadiness(input({ printedDocumentCount: 0 }));
    expect(rows.every((row) => !row.blocking || row.met)).toBe(true);
    expect(readinessNeedsAttention(rows)).toBe(true);
  });

  // A quote with no legal documents attached is unusual but not refused by
  // finalizeDocument, so the row is shown and does not block.
  it("shows the documents row as advisory", () => {
    const row = quoteReadiness(input({ printedDocumentCount: 0 })).find((r) => r.key === "documents");
    expect(row?.met).toBe(false);
    expect(row?.blocking).toBe(false);
  });

  it("does not turn the discount cap into a row", () => {
    expect(quoteReadiness(input({ capExceeded: true })).every((r) => r.met)).toBe(true);
  });
});

describe("isFinalizable", () => {
  it("is true when every blocking row is met", () => {
    expect(isFinalizable(input())).toBe(true);
  });

  it("is false while a blocking row is unmet", () => {
    expect(isFinalizable(input({ items: [] }))).toBe(false);
    expect(isFinalizable(input({ items: [item({ productionSpec: {} })] }))).toBe(false);
  });

  it("does not block on the advisory documents row", () => {
    expect(isFinalizable(input({ printedDocumentCount: 0 }))).toBe(true);
  });

  it("is false over the discount cap or the markup ceiling, which are not rows", () => {
    expect(isFinalizable(input({ capExceeded: true }))).toBe(false);
    expect(isFinalizable(input({ exceedsMarkupCap: true }))).toBe(false);
  });
});
