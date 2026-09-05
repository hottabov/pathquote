import { describe, it, expect } from "vitest";
import { contentBlockSchema, regionCodeSchema, CONTENT_KEY_REGEX } from "../src/lib/validation/content";
import { accepts, rejects } from "./helpers/schema";

describe("CONTENT_KEY_REGEX", () => {
  it("accepts every real key shape used in content-blocks.json", () => {
    for (const key of [
      "terms.delivery",
      "option.OFD",
      "software.pathworks-i",
      "software.WPN-panel",
      "equipment.fabric-master",
      "conditions.1",
      "rsp.agreement",
      "machine.m-series",
    ]) {
      expect(CONTENT_KEY_REGEX.test(key), `expected "${key}" to match`).toBe(true);
    }
  });

  it("rejects keys shorter than 2 characters", () => {
    expect(CONTENT_KEY_REGEX.test("a")).toBe(false);
  });

  it("rejects keys longer than 60 characters", () => {
    expect(CONTENT_KEY_REGEX.test("a".repeat(61))).toBe(false);
  });

  it("accepts a key at exactly the 60 character bound", () => {
    expect(CONTENT_KEY_REGEX.test("a".repeat(60))).toBe(true);
  });

  it("rejects keys with spaces or other punctuation", () => {
    for (const key of ["terms delivery", "terms/delivery", "terms_delivery", "terms.delivery!"]) {
      expect(CONTENT_KEY_REGEX.test(key), `expected "${key}" to be rejected`).toBe(false);
    }
  });
});

describe("contentBlockSchema", () => {
  const base = {
    key: "terms.delivery",
    title: "Delivery",
    body: "Included in sale price.",
    sortOrder: "3",
  };

  it("accepts a valid block and coerces sortOrder to a number", () => {
    const result = contentBlockSchema.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.title).toBe("Delivery");
      expect(result.data.sortOrder).toBe(3);
    }
  });

  rejects(contentBlockSchema, [["an invalid key", { ...base, key: "bad key!" }]]);

  it("collapses a missing/blank title to undefined", () => {
    for (const title of [undefined, null, "", "   "]) {
      const result = contentBlockSchema.safeParse({ ...base, title });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.title).toBeUndefined();
    }
  });

  accepts(contentBlockSchema, [
    ["a body at exactly the 20000 character bound", { ...base, body: "A".repeat(20000) }],
    [
      "a body with markdown and {{placeholder}} tokens",
      { ...base, body: "## Heading\n\n- Item one\n- Item two ({{token}})\n" },
    ],
  ]);

  rejects(contentBlockSchema, [
    ["a title over 200 characters", { ...base, title: "A".repeat(201) }],
    ["an empty body", { ...base, body: "" }],
    ["a body over 20000 characters", { ...base, body: "A".repeat(20001) }],
  ]);

  it("defaults a missing/blank sortOrder to 0", () => {
    for (const sortOrder of [undefined, null, ""]) {
      const result = contentBlockSchema.safeParse({ ...base, sortOrder });
      expect(result.success).toBe(true);
      if (result.success) expect(result.data.sortOrder).toBe(0);
    }
  });

  rejects(contentBlockSchema, [
    ["a negative sortOrder", { ...base, sortOrder: "-1" }],
    ["a non-integer sortOrder", { ...base, sortOrder: "1.5" }],
  ]);
});

describe("regionCodeSchema", () => {
  accepts(regionCodeSchema, [
    ["a lowercase code, normalized to uppercase", "au", "AU"],
    ["a 2-letter code", "AU"],
    ["a 3-letter code", "USA"],
  ]);

  rejects(regionCodeSchema, [
    ["a code with digits", "A1"],
    ["an empty code", ""],
  ]);
});
