import { describe, it, expect } from "vitest";
import { isFinalizable, quoteReadiness, type ReadinessInput } from "../src/lib/quote-readiness";

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
    unitPriceCents: 18_800_000,
    ...over,
  };
}

function input(over: Partial<ReadinessInput> = {}): ReadinessInput {
  return {
    hasCompany: true,
    hasContact: true,
    items: [item()],
    deliveryTerms: "DELIVERED",
    printedDocumentCount: 3,
    capExceeded: false,
    exceedsMarkupCap: false,
    ...over,
  };
}

describe("quoteReadiness", () => {
  it("returns every row even when all of them are met", () => {
    const rows = quoteReadiness(input());
    expect(rows.map((r) => r.key)).toEqual(["client", "items", "spec", "delivery", "documents"]);
    expect(rows.every((r) => r.met)).toBe(true);
  });

  // The rail renders these in order. If the order moved as rows were
  // satisfied, the list would reshuffle under the user's cursor while they
  // were working down it.
  it("keeps the same order whatever is missing", () => {
    const keys = (i: ReadinessInput) => quoteReadiness(i).map((r) => r.key);
    expect(keys(input({ hasContact: false }))).toEqual(keys(input()));
    expect(keys(input({ items: [] }))).toEqual(keys(input()));
  });

  it("fails the client row when the company is set but the contact is not", () => {
    const row = quoteReadiness(input({ hasContact: false })).find((r) => r.key === "client");
    expect(row?.met).toBe(false);
    expect(row?.detail).toBe("No contact selected");
  });

  it("names the company as the problem when neither is set", () => {
    const row = quoteReadiness(input({ hasCompany: false, hasContact: false })).find(
      (r) => r.key === "client"
    );
    expect(row?.detail).toBe("No company selected");
  });

  it("fails the items row on an empty quote", () => {
    const row = quoteReadiness(input({ items: [] })).find((r) => r.key === "items");
    expect(row?.met).toBe(false);
    expect(row?.detail).toBe("No machines yet");
    expect(row?.label).toBe("Machines priced");
  });

  it("counts the machines in the row label", () => {
    expect(quoteReadiness(input()).find((r) => r.key === "items")?.label).toBe("1 machine priced");
    expect(
      quoteReadiness(input({ items: [item(), item({ id: "i2" })] })).find((r) => r.key === "items")
        ?.label
    ).toBe("2 machines priced");
  });

  it("fails the items row when a machine has no price, and points at it", () => {
    const rows = quoteReadiness(
      input({ items: [item(), item({ id: "i2", code: "L-220", unitPriceCents: 0 })] })
    );
    const row = rows.find((r) => r.key === "items");
    expect(row?.met).toBe(false);
    expect(row?.detail).toBe("L-220 has no price");
    expect(row?.targetItemId).toBe("i2");
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
    expect(row?.detail).toBe("2 machines incomplete, starting with M-3220");
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
    expect(exWorks?.detail).toBe("Ex Works, no GST charged");
    expect(exWorks?.targetTab).toBe("terms");
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
    expect(isFinalizable(input({ hasContact: false }))).toBe(false);
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
