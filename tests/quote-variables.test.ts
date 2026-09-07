// Pure registry — no DB, no next/*, same discipline as machine-specs.test.ts.
import { describe, it, expect } from "vitest";
import {
  CATEGORY_TOKENS,
  CATEGORY_TOKEN_NAMES,
  categorySpecPresence,
  categoryTokensFor,
  findUnknownTokens,
  tokensIn,
  type CategorySpecPresence,
} from "../src/lib/quote-variables";

const noSpecs: CategorySpecPresence = {
  cutHeightCm: false,
  cutWidthCm: false,
  tableWidthMm: false,
  paperWidthMm: false,
  hasMachine: false,
  hasTableLayout: false,
};

describe("tokensIn", () => {
  it("finds every placeholder in a body", () => {
    expect(tokensIn("A {{model}} cutting {{cutWidthCm}}cm wide")).toEqual(["model", "cutWidthCm"]);
  });

  it("tolerates inner whitespace the renderer also tolerates", () => {
    expect(tokensIn("{{ model }}")).toEqual(["model"]);
  });

  it("returns each token once, in first-seen order", () => {
    expect(tokensIn("{{model}} and {{model}} and {{price}}")).toEqual(["model", "price"]);
  });

  it("returns an empty array for a body with no placeholders", () => {
    expect(tokensIn("<p>Plain copy.</p>")).toEqual([]);
  });
});

describe("categoryTokensFor", () => {
  it("always offers the tokens every product carries", () => {
    const names = categoryTokensFor(noSpecs).map((t) => t.token);
    expect(names).toEqual(["model", "name", "price", "basePrice"]);
  });

  it("offers cutHeightCm only when some product in the category has one", () => {
    const without = categoryTokensFor(noSpecs).map((t) => t.token);
    expect(without).not.toContain("cutHeightCm");

    const withIt = categoryTokensFor({ ...noSpecs, cutHeightCm: true }).map((t) => t.token);
    expect(withIt).toContain("cutHeightCm");
  });

  it("offers specSentence only for a category containing a cutting machine", () => {
    expect(categoryTokensFor(noSpecs).map((t) => t.token)).not.toContain("specSentence");
    expect(categoryTokensFor({ ...noSpecs, hasMachine: true }).map((t) => t.token)).toContain("specSentence");
  });

  it("offers tableLengthM only for a category containing a table product", () => {
    // The scope rule for the one COMPUTED token: its figure is summed from
    // the item's own EasyLoader module option lines, so only a category whose
    // products can carry a layout at all has any business referencing it.
    expect(categoryTokensFor(noSpecs).map((t) => t.token)).not.toContain("tableLengthM");
    expect(categoryTokensFor({ ...noSpecs, hasTableLayout: true }).map((t) => t.token)).toContain("tableLengthM");
  });

  it("does not offer tableLengthM to a category that merely records a table WIDTH", () => {
    // `tableWidthMm` is a spec on the product; `tableLengthM` is a property of
    // how the item was configured. A Punchline-style product carrying a width
    // is not a table someone builds out of 1.2m modules.
    expect(categoryTokensFor({ ...noSpecs, tableWidthMm: true }).map((t) => t.token)).not.toContain("tableLengthM");
  });

  it("gives every offered token a source description for the editor", () => {
    for (const token of categoryTokensFor({ ...noSpecs, cutWidthCm: true })) {
      expect(token.source.length).toBeGreaterThan(0);
    }
  });
});

describe("findUnknownTokens", () => {
  const specs: CategorySpecPresence = { ...noSpecs, cutWidthCm: true };

  it("accepts a body using only in-scope tokens", () => {
    expect(findUnknownTokens("{{model}} at {{cutWidthCm}}cm", categoryTokensFor(specs))).toEqual([]);
  });

  it("rejects a token this category has no data for", () => {
    // The spec's motivating example: a table template cannot ask for cut height.
    expect(findUnknownTokens("{{cutHeightCm}} high", categoryTokensFor(specs))).toEqual(["cutHeightCm"]);
  });

  it("rejects a token that exists nowhere in the app", () => {
    expect(findUnknownTokens("{{rspYear2Cost}}", categoryTokensFor(specs))).toEqual(["rspYear2Cost"]);
  });

  it("reports every unknown token, not just the first", () => {
    expect(findUnknownTokens("{{a}} {{model}} {{b}}", categoryTokensFor(specs))).toEqual(["a", "b"]);
  });
});

describe("CATEGORY_TOKENS", () => {
  it("declares no token twice", () => {
    const names = CATEGORY_TOKENS.map((t) => t.token);
    expect(new Set(names).size).toBe(names.length);
  });

  it("is exactly this list, in palette order", () => {
    // Pinned rather than merely checked for duplicates: a DELETED token is
    // invisible to every other assertion in this file, and deleting one
    // silently strips its line from every quote that used it. The list is
    // also what `buildQuotationData`'s `vars` is typed against, so changing
    // it is a deliberate act that should have to change this line too.
    expect(CATEGORY_TOKEN_NAMES).toEqual([
      "model",
      "name",
      "price",
      "basePrice",
      "cutHeightCm",
      "cutWidthCm",
      "tableWidthMm",
      "tableLengthM",
      "paperWidthMm",
      "specSentence",
    ]);
  });

  it("describes every name it declares, in the same order", () => {
    expect(CATEGORY_TOKENS.map((t) => t.token)).toEqual([...CATEGORY_TOKEN_NAMES]);
    for (const token of CATEGORY_TOKENS) {
      expect(token.source.length).toBeGreaterThan(0);
    }
  });
});

describe("categorySpecPresence", () => {
  it("yields all-false for an empty product list", () => {
    expect(categorySpecPresence([])).toEqual(noSpecs);
  });

  it("sets only cutWidthCm for a product with cutWidthCm but no cutHeightCm (the L-Series case)", () => {
    const presence = categorySpecPresence([{ specs: { cutWidthCm: 220 }, kind: "MACHINE" }]);
    expect(presence.cutWidthCm).toBe(true);
    expect(presence.cutHeightCm).toBe(false);
  });

  it("sets hasMachine for a product of kind MACHINE", () => {
    expect(categorySpecPresence([{ specs: {}, kind: "MACHINE" }]).hasMachine).toBe(true);
    expect(categorySpecPresence([{ specs: {}, kind: "TABLE" }]).hasMachine).toBe(false);
  });

  it("sets hasTableLayout for a product of kind TABLE (an EasyLoader)", () => {
    expect(categorySpecPresence([{ specs: {}, kind: "TABLE" }]).hasTableLayout).toBe(true);
    expect(categorySpecPresence([{ specs: {}, kind: "MACHINE" }]).hasTableLayout).toBe(false);
  });

  it("tolerates unparseable specs, contributing nothing", () => {
    expect(categorySpecPresence([{ specs: "not an object", kind: "ACCESSORY" }])).toEqual(noSpecs);
  });

  it("unions presence across every product in the category", () => {
    const presence = categorySpecPresence([
      { specs: {}, kind: "ACCESSORY" },
      { specs: { cutHeightCm: 5 }, kind: "MACHINE" },
    ]);
    expect(presence.cutHeightCm).toBe(true);
  });
});
