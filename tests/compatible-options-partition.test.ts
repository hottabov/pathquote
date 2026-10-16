import { describe, expect, it } from "vitest";
import { compatibilityOrFilter } from "../src/lib/catalog-compat";
import {
  isCompatibleWith,
  partitionByCompatKey,
  type CompatKey,
  type CompatRow,
} from "../src/lib/compatible-options-partition";

/**
 * The database's answer to `compatibilityOrFilter`, evaluated in memory, so
 * the partition's own membership test can be checked against the filter the
 * per-product query used to send. A row matches an OR clause when its one
 * named column equals the clause's value -- the Prisma semantics of
 * `{ seriesId: X }` / `{ productId: Y }` inside `compat: { some: { OR } }`.
 */
function matchesViaFilter(rows: CompatRow[], productId: string | null, seriesId: string | null): boolean {
  const or = compatibilityOrFilter(productId, seriesId);
  if (!or) return false;
  return rows.some((row) =>
    or.some((clause) =>
      "seriesId" in clause ? row.seriesId === clause.seriesId : row.productId === clause.productId
    )
  );
}

const EL = { key: "prod_EL2020", productId: "prod_EL2020", seriesId: "series_EL" };
const EL_OTHER = { key: "prod_EL1500", productId: "prod_EL1500", seriesId: "series_EL" };
const MTS = { key: "prod_MTS", productId: "prod_MTS", seriesId: "series_MTS" };
const ORPHAN = { key: "series:series_EL", productId: null, seriesId: "series_EL" };

const seriesLevel = { id: "opt_series", sortOrder: 1, compat: [{ seriesId: "series_EL", productId: null }] };
const productLevel = { id: "opt_product", sortOrder: 2, compat: [{ seriesId: null, productId: "prod_EL2020" }] };
const mtsOnly = { id: "opt_mts", sortOrder: 3, compat: [{ seriesId: "series_MTS", productId: null }] };
const both = {
  id: "opt_both",
  sortOrder: 4,
  compat: [
    { seriesId: "series_MTS", productId: null },
    { seriesId: null, productId: "prod_EL1500" },
  ],
};
const options = [seriesLevel, productLevel, mtsOnly, both];

describe("isCompatibleWith", () => {
  it("agrees with compatibilityOrFilter for every option and key", () => {
    const keys: CompatKey[] = [EL, EL_OTHER, MTS, ORPHAN, { key: "none", productId: null, seriesId: null }];
    for (const key of keys) {
      for (const option of options) {
        expect(isCompatibleWith(option.compat, key), `${option.id} vs ${key.key}`).toBe(
          matchesViaFilter(option.compat, key.productId, key.seriesId)
        );
      }
    }
  });

  it("matches a series-level row for every product in the series", () => {
    expect(isCompatibleWith(seriesLevel.compat, EL)).toBe(true);
    expect(isCompatibleWith(seriesLevel.compat, EL_OTHER)).toBe(true);
  });

  it("matches a product-level row only for that product", () => {
    // EasyLoader accessories are compatible with EL-2020 alone, not the
    // whole series -- the case product-level rows exist for.
    expect(isCompatibleWith(productLevel.compat, EL)).toBe(true);
    expect(isCompatibleWith(productLevel.compat, EL_OTHER)).toBe(false);
  });

  it("matches nothing for a key with neither id", () => {
    expect(isCompatibleWith(seriesLevel.compat, { key: "none", productId: null, seriesId: null })).toBe(false);
  });

  it("does not let a null column match a null key field", () => {
    // A key without a product must not match a series-level row's null
    // productId, nor a product-level row's null seriesId match a key with
    // no series -- null equals nothing, as in SQL.
    expect(isCompatibleWith(productLevel.compat, ORPHAN)).toBe(false);
    expect(isCompatibleWith([{ seriesId: null, productId: null }], EL)).toBe(false);
  });
});

describe("partitionByCompatKey", () => {
  it("gives each key the options its own query would have returned, in the same order", () => {
    const result = partitionByCompatKey([EL, EL_OTHER, MTS], options);
    expect(result.prod_EL2020.map((o) => o.id)).toEqual(["opt_series", "opt_product"]);
    expect(result.prod_EL1500.map((o) => o.id)).toEqual(["opt_series", "opt_both"]);
    expect(result.prod_MTS.map((o) => o.id)).toEqual(["opt_mts", "opt_both"]);
  });

  it("gives every key an entry, empty when nothing matches", () => {
    const result = partitionByCompatKey([{ key: "prod_X", productId: "prod_X", seriesId: "series_X" }], options);
    expect(result).toEqual({ prod_X: [] });
  });

  it("keys the orphan product by its series and still finds the series-level options", () => {
    const result = partitionByCompatKey([ORPHAN], options);
    expect(result["series:series_EL"].map((o) => o.id)).toEqual(["opt_series"]);
  });

  it("returns nothing for no keys", () => {
    expect(partitionByCompatKey([], options)).toEqual({});
  });

  it("hands the same option object to every key it fits, not a copy", () => {
    const result = partitionByCompatKey([EL, EL_OTHER], options);
    expect(result.prod_EL2020[0]).toBe(result.prod_EL1500[0]);
  });
});
