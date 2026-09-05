import { describe, it, expect } from "vitest";
import {
  creditUnitPriceSchema,
  customLineSchema,
  discountModeSchema,
  discountValueSchema,
  exceedsPercentCeiling,
  idSchema,
  isPermutation,
  notesSchema,
  optionSelectionSchema,
  optionalIdSchema,
  priceDisplaySchema,
  reorderSchema,
  unitPriceSchema,
  validityDaysSchema,
} from "../src/lib/validation/documents";
import { accepts, rejects } from "./helpers/schema";

describe("idSchema", () => {
  accepts(idSchema, [
    ["a cuid-shaped id", "cldz9x1a30000abcd1234efgh"],
    ["an id with surrounding whitespace, trimmed", "  cldz9x1a30000abcd1234efgh  ", "cldz9x1a30000abcd1234efgh"],
  ]);

  rejects(idSchema, [
    ["an empty string", ""],
    ["an id shorter than 10 characters", "short"],
    ["an id longer than 40 characters", "a".repeat(41)],
    ["a non-string value", 12345],
  ]);
});

describe("optionalIdSchema", () => {
  accepts(optionalIdSchema, [["a valid id", "cldz9x1a30000abcd1234efgh"]]);

  it("collapses missing/blank optionalId to undefined", () => {
    for (const value of [undefined, null, "", "   "]) {
      const result = optionalIdSchema.safeParse(value);
      expect(result.success).toBe(true);
      if (result.success) expect(result.data).toBeUndefined();
    }
  });

  rejects(optionalIdSchema, [["an invalid non-empty id", "short"]]);
});

describe("discountModeSchema", () => {
  accepts(discountModeSchema, [
    ["PERCENT", "PERCENT"],
    ["AMOUNT", "AMOUNT"],
  ]);

  rejects(discountModeSchema, [
    ["an unknown mode", "PCT"],
    ["a blank mode", ""],
  ]);
});

describe("discountValueSchema", () => {
  accepts(discountValueSchema, [
    ["a two-decimal value, kept as a string", "10.55", "10.55"],
    ["a large AMOUNT-shaped figure (up to 9 digits before the point)", "123456789", "123456789"],
    ["exactly 100", "100", "100"],
    ["exactly 0", "0", "0"],
  ]);

  it("accepts a value over 100 — the 0..100 ceiling is mode-dependent, enforced by exceedsPercentCeiling instead", () => {
    const result = discountValueSchema.safeParse("101");
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toBe("101");
  });

  it("collapses a missing/blank discount value to null", () => {
    for (const value of [undefined, null, ""]) {
      const result = discountValueSchema.safeParse(value);
      expect(result.success).toBe(true);
      if (result.success) expect(result.data).toBeNull();
    }
  });

  rejects(discountValueSchema, [
    ["a three-decimal value", "10.555"],
    ["a negative value", "-5"],
    ["a non-numeric string", "abc"],
  ]);
});

describe("exceedsPercentCeiling", () => {
  it("flags a PERCENT value over 100", () => {
    expect(exceedsPercentCeiling("PERCENT", "101")).toBe(true);
    expect(exceedsPercentCeiling("PERCENT", "150000")).toBe(true);
  });

  it("does not flag a PERCENT value at or under 100", () => {
    expect(exceedsPercentCeiling("PERCENT", "100")).toBe(false);
    expect(exceedsPercentCeiling("PERCENT", "10.55")).toBe(false);
  });

  it("never flags an AMOUNT value, however large — the engine clamps it to its base instead", () => {
    expect(exceedsPercentCeiling("AMOUNT", "150000")).toBe(false);
  });

  it("never flags a null value, regardless of mode", () => {
    expect(exceedsPercentCeiling("PERCENT", null)).toBe(false);
    expect(exceedsPercentCeiling("AMOUNT", null)).toBe(false);
  });
});

describe("customLineSchema", () => {
  const valid = { name: "Delivery", qty: "1", unitPrice: "150.00", description: "" };

  it("accepts valid input", () => {
    const result = customLineSchema.safeParse(valid);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data).toEqual({
        name: "Delivery",
        qty: 1,
        unitPrice: "150.00",
        description: undefined,
        imageUrl: undefined,
      });
    }
  });

  accepts(customLineSchema, [
    [
      "a description",
      { ...valid, description: "Freight to site" },
      { name: "Delivery", qty: 1, unitPrice: "150.00", description: "Freight to site", imageUrl: undefined },
    ],
    ["qty at the 999 boundary", { ...valid, qty: "999" }],
    ["a negative unit price (a trade-in)", { ...valid, unitPrice: "-1" }],
    [
      "a negative custom line for a trade-in",
      {
        name: "Trade-in K5 390",
        qty: "1",
        unitPrice: "-15000.00",
        description: "Serial 12345. Customer responsible for removal.",
      },
    ],
    ["a zero unit price", { ...valid, unitPrice: "0" }],
    [
      "a well-formed imageUrl",
      { ...valid, imageUrl: "/api/files/a1b2c3d4-e5f6-4789-a0b1-c2d3e4f56789.jpg" },
      {
        name: "Delivery",
        qty: 1,
        unitPrice: "150.00",
        description: undefined,
        imageUrl: "/api/files/a1b2c3d4-e5f6-4789-a0b1-c2d3e4f56789.jpg",
      },
    ],
    [
      "a blank imageUrl, collapsed to undefined",
      { ...valid, imageUrl: "" },
      { name: "Delivery", qty: 1, unitPrice: "150.00", description: undefined, imageUrl: undefined },
    ],
  ]);

  rejects(customLineSchema, [
    ["an empty name", { ...valid, name: "" }],
    ["a name over 200 characters", { ...valid, name: "a".repeat(201) }],
    ["qty 0", { ...valid, qty: "0" }],
    ["qty 1000", { ...valid, qty: "1000" }],
    ["a fractional qty", { ...valid, qty: "1.5" }],
    ["a unit price with three decimal places", { ...valid, unitPrice: "1.234" }],
    [
      "a negative amount with more than two decimals",
      { name: "Trade-in", qty: "1", unitPrice: "-1.005", description: undefined },
    ],
    ["a description over 500 characters", { ...valid, description: "a".repeat(501) }],
  ]);

  it("rejects an imageUrl that isn't a well-formed /api/files/ URL", () => {
    expect(customLineSchema.safeParse({ ...valid, imageUrl: "https://evil.example/x.jpg" }).success).toBe(
      false
    );
  });
});

describe("optionSelectionSchema", () => {
  accepts(optionSelectionSchema, [
    [
      "a selection with no attributes",
      { optionCode: "MTS", qty: 1 },
      { optionCode: "MTS", qty: 1, attributes: undefined },
    ],
    [
      "a selection with attributes",
      { optionCode: "VRB-180", qty: 2, attributes: { metres: 4, label: "north" } },
      { optionCode: "VRB-180", qty: 2, attributes: { metres: 4, label: "north" } },
    ],
  ]);

  rejects(optionSelectionSchema, [
    ["a missing option code", { optionCode: "", qty: 1 }],
    ["qty 0", { optionCode: "MTS", qty: 0 }],
    ["qty over 999", { optionCode: "MTS", qty: 1000 }],
    ["a non-string/number attribute value", { optionCode: "MTS", qty: 1, attributes: { metres: true } }],
  ]);
});

describe("reorderSchema", () => {
  const id1 = "cldz9x1a30000abcd1234efgh";
  const id2 = "cldz9x1a30001abcd1234efgh";
  const id3 = "cldz9x1a30002abcd1234efgh";
  const ids = (count: number) =>
    Array.from({ length: count }, (_, i) => `cldz9x1a3${String(i).padStart(4, "0")}abcd1234efgh`);

  accepts(reorderSchema, [
    ["a list of valid ids", [id1, id2, id3], [id1, id2, id3]],
    ["a single id", [id1]],
    ["exactly 100 ids", ids(100)],
  ]);

  rejects(reorderSchema, [
    ["an empty array", []],
    ["more than 100 ids", ids(101)],
    ["a duplicate id", [id1, id2, id1]],
    ["an invalid id in the list", [id1, "short"]],
    ["a non-array value", id1],
  ]);
});

describe("isPermutation", () => {
  it("returns true for the same set in a different order", () => {
    expect(isPermutation(["a", "b", "c"], ["c", "a", "b"])).toBe(true);
  });

  it("returns true for identical order", () => {
    expect(isPermutation(["a", "b"], ["a", "b"])).toBe(true);
  });

  it("returns true for two empty arrays", () => {
    expect(isPermutation([], [])).toBe(true);
  });

  it("returns false when a member is missing", () => {
    expect(isPermutation(["a", "b"], ["a", "b", "c"])).toBe(false);
  });

  it("returns false when an extra member is present", () => {
    expect(isPermutation(["a", "b", "c"], ["a", "b"])).toBe(false);
  });

  it("returns false when proposed has a duplicate", () => {
    expect(isPermutation(["a", "a"], ["a", "b"])).toBe(false);
  });

  it("returns false when actual has a duplicate", () => {
    expect(isPermutation(["a", "b"], ["a", "a"])).toBe(false);
  });

  it("returns false when sets differ entirely", () => {
    expect(isPermutation(["a", "b"], ["c", "d"])).toBe(false);
  });
});

describe("priceDisplaySchema", () => {
  accepts(priceDisplaySchema, [
    ["both flags false", { showItemPrices: false, showOptionPrices: false }],
    ["both flags true", { showItemPrices: true, showOptionPrices: true }],
  ]);

  rejects(priceDisplaySchema, [
    ["a non-boolean value", { showItemPrices: "true", showOptionPrices: false }],
    ["a missing field", { showItemPrices: true }],
    ["a non-object input", null],
  ]);
});

describe("notesSchema", () => {
  it("collapses a missing/blank body to null (clears notes)", () => {
    for (const value of [undefined, null, "", "   "]) {
      const result = notesSchema.safeParse(value);
      expect(result.success).toBe(true);
      if (result.success) expect(result.data).toBeNull();
    }
  });

  accepts(notesSchema, [
    [
      "a normal markdown body, trimmed",
      "  **Important:** handle with care.  ",
      "**Important:** handle with care.",
    ],
    ["a body at exactly the 5000 character bound", "a".repeat(5000)],
  ]);

  rejects(notesSchema, [["a body over 5000 characters", "a".repeat(5001)]]);
});

describe("unitPriceSchema", () => {
  accepts(unitPriceSchema, [
    ["a non-negative amount without cents", "20000"],
    ["a non-negative amount with cents", "20000.00"],
    ["zero", "0"],
  ]);

  it("rejects a negative amount -- an ordinary item's price has no minus-sign shorthand", () => {
    const result = unitPriceSchema.safeParse("-20000");
    expect(result.success).toBe(false);
  });
});

// A credit item (Product.isCredit -- the TRADE-IN product) may be typed
// with a leading minus, since the salesperson already sees the line as
// negative on screen -- see this schema's own doc comment
// (src/lib/validation/documents.ts) for why that's a reasonable mental
// model there and nowhere else. The sign is always stripped before storage;
// EngineItem.isCredit (src/lib/pricing.ts) is what actually applies it.
describe("creditUnitPriceSchema", () => {
  accepts(creditUnitPriceSchema, [
    ["a leading minus, stripped to the positive amount", "-20000", "20000"],
    ["a leading minus on a cents amount, stripped too", "-20000.50", "20000.50"],
    ["a plain positive amount, unchanged", "20000.00", "20000.00"],
    ["0", "0", "0"],
  ]);

  rejects(creditUnitPriceSchema, [
    ["a non-numeric value", "abc"],
    ["more than 2 decimal places", "-20000.999"],
  ]);
});


// --- was tests/validity.test.ts: validityDaysSchema ------------------

describe("validity days", () => {
  accepts(validityDaysSchema, [
    ["a value inside the usual range", "30"],
    ["a longer window for a slow capex process", "56"],
    ["a blank value, cleared to null", "", null],
    ["a year", "365"],
  ]);

  rejects(validityDaysSchema, [
    ["zero", "0"],
    ["a negative value", "-5"],
    ["anything beyond a year", "366"],
  ]);
});
