// Pure registry — no DB, no next/*, same discipline as machine-specs.test.ts.
import { describe, it, expect } from "vitest";
import {
  CATEGORY_TOKENS,
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
});
