import { describe, it, expect } from "vitest";
import { quoteReadiness, unmetBlockers, type ReadinessInput } from "../src/lib/quote-readiness";

// Pure module: no Prisma client, no DATABASE_URL, same discipline as
// tests/production-readiness.test.ts, which covers the per-item check this
// one wraps.

const COMPLETE_SPEC = { knifeSize: "1.5x7.0", voltage: "400V" };

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

/** Whether Finalize would be allowed -- what the button is gated on. */
function finalizable(i: ReadinessInput): boolean {
  return unmetBlockers(quoteReadiness(i)).length === 0;
}

/** Whether the Summary panel draws anything at all. */
function needsAttention(i: ReadinessInput): boolean {
  return quoteReadiness(i).some((row) => row.needsAttention);
}

function input(over: Partial<ReadinessInput> = {}): ReadinessInput {
  return {
    hasCompany: true,
    hasContact: true,
    items: [item()],
    extraLineCount: 0,
    printedDocumentCount: 3,
    discountViolations: [],
    discountCapMessage: null,
    markupCapMessage: null,
    pathWorksModulesWithoutHost: false,
    taxBlocker: null,
    ...over,
  };
}

describe("quoteReadiness", () => {
  it("returns every row even when all of them are met", () => {
    const rows = quoteReadiness(input());
    expect(rows.map((r) => r.key)).toEqual(["client", "items", "spec", "documents"]);
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
    expect(finalizable(input({ hasContact: false }))).toBe(true);
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
    expect(finalizable(input({ items: [], extraLineCount: 1 }))).toBe(true);
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
    expect(finalizable(input({ items: [easyLoader, freeService] }))).toBe(true);
  });

  it("names the machine and the missing fields on an incomplete production spec", () => {
    const rows = quoteReadiness(input({ items: [item({ productionSpec: {} })] }));
    const row = rows.find((r) => r.key === "spec");
    expect(row?.met).toBe(false);
    expect(row?.detail).toBe("M-7220: knife size, voltage");
  });

  // No link to the item any more, so the row itself has to say which ones:
  // every incomplete item, in the finalize error's own words.
  it("lists every incomplete machine when several are", () => {
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
    expect(row?.detail).toBe("M-3220: knife size, voltage; L-220: knife size, voltage");
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
    expect(finalizable(input({ pathWorksModulesWithoutHost: true }))).toBe(true);
  });
});

describe("panel visibility", () => {
  it("is false for a quote with nothing missing, unusual or incompatible", () => {
    expect(needsAttention(input())).toBe(false);
  });

  it("is true while a blocking row is unmet", () => {
    expect(needsAttention(input({ hasCompany: false }))).toBe(true);
  });

  it("is true for an advisory row alone, with every blocking row met", () => {
    // The case the panel exists for once a quote is otherwise finished:
    // nothing is wrong, something is unusual.
    const rows = quoteReadiness(input({ printedDocumentCount: 0 }));
    expect(rows.every((row) => !row.blocking || row.met)).toBe(true);
    expect(rows.some((row) => row.needsAttention)).toBe(true);
  });

  // A quote with no legal documents attached is unusual but not refused by
  // finalizeDocument, so the row is shown and does not block.
  it("shows the documents row as advisory", () => {
    const row = quoteReadiness(input({ printedDocumentCount: 0 })).find((r) => r.key === "documents");
    expect(row?.met).toBe(false);
    expect(row?.blocking).toBe(false);
  });

});

describe("unmetBlockers", () => {
  it("is true when every blocking row is met", () => {
    expect(finalizable(input())).toBe(true);
  });

  it("is false while a blocking row is unmet", () => {
    expect(finalizable(input({ items: [] }))).toBe(false);
    expect(finalizable(input({ items: [item({ productionSpec: {} })] }))).toBe(false);
  });

  it("is false while the tax is undecided, even with a company chosen", () => {
    expect(finalizable(input({ hasCompany: true, taxBlocker: "Set the client's delivery country" }))).toBe(false);
  });

  it("does not block on the advisory documents row", () => {
    expect(finalizable(input({ printedDocumentCount: 0 }))).toBe(true);
  });

  it("is false over the discount cap or the markup ceiling", () => {
    expect(finalizable(input({ discountCapMessage: "Concessions total 25%" }))).toBe(false);
    expect(finalizable(input({ markupCapMessage: "Priced 40% above list" }))).toBe(false);
  });

  it("is false while an item's own discount is over the limit", () => {
    expect(finalizable(input({ discountViolations: [{ code: "M-7220", allowedPct: 15 }] }))).toBe(false);
  });
});

describe("quoteReadiness — delivery & tax", () => {
  it("adds no tax row when the tax is settled", () => {
    expect(quoteReadiness(input()).some((row) => row.key === "tax")).toBe(false);
  });

  it("adds a blocking tax row", () => {
    const row = quoteReadiness(input({ taxBlocker: "DDP abroad: set Canada's tax with Custom" })).find((r) => r.key === "tax");
    expect(row).toMatchObject({
      label: "Delivery & tax",
      met: false,
      needsAttention: true,
      blocking: true,
      detail: "DDP abroad: set Canada's tax with Custom",
    });
  });

  // It used to wait for a company, which also hid "give a reason for the
  // custom tax" -- a refusal that has nothing to do with the client.
  it("is shown with or without a company", () => {
    const rows = quoteReadiness(input({ hasCompany: false, taxBlocker: "Give a reason for the custom tax" }));
    expect(rows.find((row) => row.key === "tax")?.detail).toBe("Give a reason for the custom tax");
  });
});

// Every refusal `finalizeDocument` can return has a row. The per-item
// discount was the one that did not: saved with a one-off toast, shown
// nowhere after, and refused only once Finalize was clicked.
describe("quoteReadiness — limits", () => {
  it("adds no limit rows while the quote is within them", () => {
    const keys = quoteReadiness(input()).map((row) => row.key);
    expect(keys).not.toContain("itemDiscount");
    expect(keys).not.toContain("discountCap");
    expect(keys).not.toContain("markupCap");
  });

  it("names every item whose own discount is over the limit", () => {
    const row = quoteReadiness(
      input({
        discountViolations: [
          { code: "M-7220", allowedPct: 15 },
          { code: "L-220", allowedPct: 15 },
        ],
      })
    ).find((r) => r.key === "itemDiscount");
    expect(row).toMatchObject({ met: false, blocking: true, needsAttention: true });
    expect(row?.detail).toBe("M-7220: above the 15% limit; L-220: above the 15% limit");
  });

  it("carries the region cap and ceiling messages as blocking rows", () => {
    const cap = quoteReadiness(input({ discountCapMessage: "Concessions total 25%" })).find(
      (r) => r.key === "discountCap"
    );
    expect(cap).toMatchObject({ label: "Discount limit", detail: "Concessions total 25%", blocking: true });

    const ceiling = quoteReadiness(input({ markupCapMessage: "Priced 40% above list" })).find(
      (r) => r.key === "markupCap"
    );
    expect(ceiling).toMatchObject({ label: "Price ceiling", detail: "Priced 40% above list", blocking: true });
  });
});
