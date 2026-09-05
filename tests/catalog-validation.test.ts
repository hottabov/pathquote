import { describe, it, expect } from "vitest";
import {
  productSchema,
  optionSchema,
  priceInputSchema,
  compatDiff,
  maxDiscountPctSchema,
  conflictGroupNameSchema,
  reorderProductsSchema,
  isProductPermutation,
} from "../src/lib/validation/catalog";
import { accepts, rejects } from "./helpers/schema";

describe("productSchema", () => {
  const base = {
    code: "M5180",
    name: "M5180 Cutter",
    description: "A cutting machine",
    active: "on",
    sortOrder: "3",
  };

  it("accepts a valid code and stores it exactly as entered (no case normalization)", () => {
    const result = productSchema.safeParse({ ...base, code: "m5180" });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.code).toBe("m5180");
      expect(result.data.active).toBe(true);
      expect(result.data.sortOrder).toBe(3);
    }
  });

  it("accepts real seeded codes: long, mixed case, with parens/slashes/commas/apostrophes", () => {
    for (const code of [
      "Drills included",
      "MTS- additional gantry",
      "M5.180",
      "A/B",
      "Waste Bin-180",
      "Drill Guard (heavy duty), incl. mounting bracket's hardware",
      "A".repeat(120),
    ]) {
      const result = productSchema.safeParse({ ...base, code });
      expect(result.success, `expected "${code}" to be valid`).toBe(true);
      if (result.success) expect(result.data.code).toBe(code);
    }
  });

  // Codes are printable-ASCII-only, so a tab/newline/embedded-null is
  // refused up front rather than silently stored and later mangled by
  // whatever renders it in the admin UI.
  it("rejects a code containing a control character (tab, newline, null)", () => {
    for (const code of ["M5180\t", "M5180\n", "M51\x0080"]) {
      const result = productSchema.safeParse({ ...base, code });
      expect(result.success, `expected ${JSON.stringify(code)} to be invalid`).toBe(false);
    }
  });

  accepts(productSchema, [
    ["a single-character code", { ...base, code: "A" }],
    ["a code at exactly the 120 character bound", { ...base, code: "A".repeat(120) }],
    ["a code with internal spaces", { ...base, code: "M51 80" }],
    ["a code with an internal hyphen", { ...base, code: "80-code" }],
  ]);

  rejects(productSchema, [
    ["an empty code", { ...base, code: "" }],
    ["a code over 120 characters", { ...base, code: "A".repeat(121) }],
    ["a code with leading whitespace", { ...base, code: " M5180" }],
    ["a code with trailing whitespace", { ...base, code: "M5180 " }],
    ["a name shorter than 2 characters", { ...base, name: "A" }],
    ["a name over 200 characters", { ...base, name: "A".repeat(201) }],
    ["a description over 2000 characters", { ...base, description: "A".repeat(2001) }],
  ]);

  it("treats a missing/null description as absent, not an error", () => {
    const result = productSchema.safeParse({ ...base, description: null });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.description).toBeUndefined();
  });

  describe("checkbox coercion for `active`", () => {
    it('coerces the raw FormData "on" value to true', () => {
      const result = productSchema.safeParse({ ...base, active: "on" });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.active).toBe(true);
    });

    it("coerces a missing/null value (unchecked checkbox) to false", () => {
      const result = productSchema.safeParse({ ...base, active: null });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.active).toBe(false);
    });

    it("coerces an actual boolean straight through", () => {
      expect(productSchema.safeParse({ ...base, active: true }).success).toBe(true);
      const result = productSchema.safeParse({ ...base, active: true });
      if (result.success) expect(result.data.active).toBe(true);
    });

    it('treats any other string (e.g. "off") as false', () => {
      const result = productSchema.safeParse({ ...base, active: "off" });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.active).toBe(false);
    });
  });

  describe("sortOrder", () => {
    it("defaults an empty/missing value to 0", () => {
      for (const sortOrder of ["", null, undefined]) {
        const result = productSchema.safeParse({ ...base, sortOrder });
        expect(result.success).toBe(true);
        if (result.success) expect(result.data.sortOrder).toBe(0);
      }
    });

    it("coerces a numeric string", () => {
      const result = productSchema.safeParse({ ...base, sortOrder: "12" });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.sortOrder).toBe(12);
    });

    rejects(productSchema, [
      ["a negative sort order", { ...base, sortOrder: "-1" }],
      ["a non-integer sort order", { ...base, sortOrder: "1.5" }],
    ]);
  });
});

describe("optionSchema", () => {
  const base = {
    code: "MTS",
    name: "Mid Travel Skate",
    active: "on",
    sortOrder: "0",
    shortDescription: "A skate option",
    attributeSchema: "",
  };

  accepts(optionSchema, [
    ["a valid option with all product fields plus option-only fields", base],
  ]);

  rejects(optionSchema, [
    ["a shortDescription over 500 characters", { ...base, shortDescription: "A".repeat(501) }],
    ["a code with leading whitespace (base product rule)", { ...base, code: " leading space" }],
    ["an empty code (base product rule)", { ...base, code: "" }],
    ["a name shorter than 2 characters (base product rule)", { ...base, name: "A" }],
  ]);

  describe("attributeSchema JSON refine", () => {
    it("collapses an empty string to null", () => {
      const result = optionSchema.safeParse({ ...base, attributeSchema: "" });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.attributeSchema).toBeNull();
    });

    it("collapses whitespace-only input to null", () => {
      const result = optionSchema.safeParse({ ...base, attributeSchema: "   " });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.attributeSchema).toBeNull();
    });

    it("collapses a missing/null value to null", () => {
      const result = optionSchema.safeParse({ ...base, attributeSchema: null });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.attributeSchema).toBeNull();
    });

    it("parses a valid JSON array", () => {
      const result = optionSchema.safeParse({
        ...base,
        attributeSchema: '[{"key":"metres","label":"Travel (m)","type":"number"}]',
      });
      expect(result.success).toBe(true);
      if (result.success) {
        expect(result.data.attributeSchema).toEqual([
          { key: "metres", label: "Travel (m)", type: "number" },
        ]);
      }
    });

    it("parses a valid JSON object", () => {
      const result = optionSchema.safeParse({ ...base, attributeSchema: '{"metres":4}' });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.attributeSchema).toEqual({ metres: 4 });
    });

    rejects(optionSchema, [
      ["an attributeSchema value that's malformed JSON", { ...base, attributeSchema: "{not json" }],
      ["an attributeSchema value that's a bare number", { ...base, attributeSchema: "123" }],
      ["an attributeSchema value that's a bare string", { ...base, attributeSchema: '"hello"' }],
      ["an attributeSchema value that's the literal null", { ...base, attributeSchema: "null" }],
      ["an attributeSchema value that's the literal true", { ...base, attributeSchema: "true" }],
    ]);
  });
});

describe("priceInputSchema", () => {
  accepts(priceInputSchema, [
    [
      'an empty amount ("" = clear the price)',
      { regionCode: "AU", amount: "" },
      { regionCode: "AU", amount: "" },
    ],
    ["a whole-number amount", { regionCode: "AU", amount: "175000" }],
    ["an amount with exactly 2 decimal places", { regionCode: "AU", amount: "12.50" }],
    [
      "a lowercase region code, normalized to uppercase",
      { regionCode: "au", amount: "100" },
      { regionCode: "AU", amount: "100" },
    ],
  ]);

  rejects(priceInputSchema, [
    ["a negative amount", { regionCode: "AU", amount: "-1" }],
    ["an amount with more than 2 decimal places", { regionCode: "AU", amount: "1.234" }],
    ["a non-numeric amount", { regionCode: "AU", amount: "abc" }],
    ["a 1-letter region code", { regionCode: "A", amount: "100" }],
    ["a 4-letter region code", { regionCode: "ABCD", amount: "100" }],
    ["a region code with a digit", { regionCode: "A1", amount: "100" }],
    ["a blank region code", { regionCode: "", amount: "100" }],
  ]);
});

describe("compatDiff", () => {
  it("returns empty add/remove when current and submitted match", () => {
    expect(compatDiff(["M", "L"], ["M", "L"])).toEqual({ toAdd: [], toRemove: [] });
  });

  it("returns empty add/remove for two empty lists", () => {
    expect(compatDiff([], [])).toEqual({ toAdd: [], toRemove: [] });
  });

  it("detects additions", () => {
    expect(compatDiff(["M"], ["M", "L"])).toEqual({ toAdd: ["L"], toRemove: [] });
  });

  it("detects removals", () => {
    expect(compatDiff(["M", "L"], ["M"])).toEqual({ toAdd: [], toRemove: ["L"] });
  });

  it("detects a mix of additions and removals", () => {
    expect(compatDiff(["M", "L"], ["L", "XC"])).toEqual({ toAdd: ["XC"], toRemove: ["M"] });
  });

  it("handles clearing all compatibility", () => {
    expect(compatDiff(["M", "L"], [])).toEqual({ toAdd: [], toRemove: ["M", "L"] });
  });

  it("handles adding to an empty current list", () => {
    expect(compatDiff([], ["M", "L"])).toEqual({ toAdd: ["M", "L"], toRemove: [] });
  });
});

describe("conflictGroupNameSchema", () => {
  accepts(conflictGroupNameSchema, [
    ["a valid name", "Knife tools — fit one only"],
    ["a name with surrounding whitespace, trimmed", "  Knife tools  ", "Knife tools"],
  ]);

  rejects(conflictGroupNameSchema, [
    ["a name that's too short", "K"],
    ["a name over 200 characters", "x".repeat(201)],
  ]);
});

describe("maxDiscountPctSchema", () => {
  accepts(maxDiscountPctSchema, [
    ["an empty string, collapsed to null (no cap)", "", null],
    ["a missing value, collapsed to null", undefined, null],
    ["a null value, collapsed to null", null, null],
    ["an integer percentage", "10", 10],
    ["up to 2 decimal places", "12.5", 12.5],
    ["the boundary value 0", "0", 0],
    ["the boundary value 100", "100", 100],
  ]);

  rejects(maxDiscountPctSchema, [
    ["more than 2 decimal places", "10.555"],
    ["a value above 100", "101"],
    ["a negative value", "-5"],
    ["a non-numeric string", "abc"],
  ]);
});

describe("reorderProductsSchema", () => {
  accepts(reorderProductsSchema, [
    ["a non-empty list of ids", ["p1", "p2", "p3"]],
    ["a single id", ["p1"]],
  ]);

  rejects(reorderProductsSchema, [
    ["an empty list", []],
    ["a duplicate id", ["p1", "p2", "p1"]],
    ["an empty-string id", ["p1", ""]],
    ["a non-array", "p1"],
  ]);
});

describe("isProductPermutation", () => {
  it("is true for the same ids in a different order", () => {
    expect(isProductPermutation(["a", "b", "c"], ["c", "a", "b"])).toBe(true);
  });

  it("is true for two empty lists", () => {
    expect(isProductPermutation([], [])).toBe(true);
  });

  it("is false when a proposed id is missing from actual", () => {
    expect(isProductPermutation(["a", "b"], ["a", "c"])).toBe(false);
  });

  it("is false when actual has more ids than proposed", () => {
    expect(isProductPermutation(["a", "b"], ["a", "b", "c"])).toBe(false);
  });

  it("is false when proposed has a duplicate", () => {
    expect(isProductPermutation(["a", "a"], ["a", "b"])).toBe(false);
  });
});
