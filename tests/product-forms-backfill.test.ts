import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { FORM_BY_SERIES } from "../scripts/backfill-product-forms";
import { FORM_SPECS } from "../src/lib/production-forms/specs";
import type { Catalog } from "../prisma/seed-lib";

const catalog = JSON.parse(
  readFileSync(path.resolve(__dirname, "../prisma/seed-data/catalog.json"), "utf8")
) as Catalog;

/**
 * `Product.form` is what decides which order form an item prints on, and it
 * follows from the product's series with no judgement involved. These guard
 * the two ways that can silently go wrong: a series nobody mapped (its
 * machines print nothing) and a form nothing points at (a sheet that can
 * never be produced).
 */
describe("series to production form", () => {
  // The kinds that are a physical thing somebody builds. SOFTWARE and
  // SERVICE print on no machine form, and CREDIT is the trade-in line -- all
  // three are commercial rather than manufacturing information.
  const BUILT = new Set(["MACHINE", "TABLE", "FEEDER", "SPREADER", "SYSTEM", "ACCESSORY"]);
  const seriesWithMachines = catalog.series.filter((series) =>
    series.products.some((product) => product.kind !== undefined && BUILT.has(product.kind))
  );

  it("maps every series that sells a machine", () => {
    const unmapped = seriesWithMachines
      .map((series) => series.seriesCode)
      .filter((code) => !(code in FORM_BY_SERIES));

    expect(unmapped, "a series with no form prints no order form at all").toEqual([]);
  });

  it("maps software and service to nothing — they print on no machine form", () => {
    expect(FORM_BY_SERIES.SW).toBeUndefined();
    expect(FORM_BY_SERIES.SVC).toBeUndefined();
  });

  it("recognises every series in the catalogue, mapped or deliberately not", () => {
    const known = new Set([...Object.keys(FORM_BY_SERIES), "SW", "SVC"]);
    const unknown = catalog.series.map((s) => s.seriesCode).filter((code) => !known.has(code));

    expect(unknown, "a new series needs a decision: which form, or none").toEqual([]);
  });

  it("points every mapped series at a form the registry knows", () => {
    const known = new Set(FORM_SPECS.map((spec) => spec.form));
    for (const [seriesCode, form] of Object.entries(FORM_BY_SERIES)) {
      expect(known.has(form), `${seriesCode} -> ${form}`).toBe(true);
    }
  });

  it("gives every buildable form at least one series", () => {
    const mapped = new Set(Object.values(FORM_BY_SERIES));
    // PUNCHLINE is the exception: the products were deleted from the
    // catalogue on 2026-09-11 and the spec is kept only until the xlsx path
    // is removed.
    const orphans = FORM_SPECS.map((spec) => spec.form).filter(
      (form) => form !== "PUNCHLINE" && !mapped.has(form)
    );

    expect(orphans, "a form no product can reach can never be printed").toEqual([]);
  });
});
