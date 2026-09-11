import { describe, it, expect } from "vitest";
import {
  industryAliasSchema,
  industryEqualsQuery,
  industryMatchesQuery,
  industryNameSchema,
  matchingIndustryAlias,
  normalizeIndustryName,
} from "../src/lib/validation/industries";
import { accepts, rejects } from "./helpers/schema";

describe("industryNameSchema", () => {
  accepts(industryNameSchema, [
    ["a normal name", "Automotive"],
    ["surrounding whitespace, trimmed", "  Marine upholstery  ", "Marine upholstery"],
  ]);

  rejects(industryNameSchema, [
    ["an empty string", ""],
    ["whitespace only", "   "],
    ["a name longer than 80 characters", "x".repeat(81)],
  ]);
});

describe("normalizeIndustryName", () => {
  it("lowercases for comparison", () => {
    expect(normalizeIndustryName("Automotive")).toBe("automotive");
  });

  it("collapses internal whitespace", () => {
    expect(normalizeIndustryName("Marine   upholstery")).toBe("marine upholstery");
  });

  it("treats differently cased spellings as the same key", () => {
    expect(normalizeIndustryName("AUTOMOTIVE")).toBe(normalizeIndustryName("automotive"));
  });
});

describe("industryAliasSchema", () => {
  accepts(industryAliasSchema, [
    ["another system's spelling", "Retail trade"],
    ["surrounding whitespace, trimmed", "  Automotve  ", "Automotve"],
  ]);

  rejects(industryAliasSchema, [
    ["an empty string", ""],
    ["whitespace only", "   "],
    ["an alias longer than 80 characters", "x".repeat(81)],
  ]);
});

// The picker on a client card is the only thing that reads an alias today, and
// it reads it through these three. The behaviour that matters is the one that
// keeps the list from growing: an alias has to make its industry findable, has
// to say so, and has to suppress the "Create ..." option.
const retail = { name: "Retail", aliases: [{ name: "Retail trade" }, { name: "Retailing" }] };
const marine = { name: "Marine upholstery", aliases: [] };

describe("industryMatchesQuery", () => {
  it("matches on the industry's own name", () => {
    expect(industryMatchesQuery(retail, "reta")).toBe(true);
  });

  it("matches on an alias", () => {
    expect(industryMatchesQuery(retail, "trade")).toBe(true);
  });

  it("ignores case and repeated whitespace, like the dedup key", () => {
    expect(industryMatchesQuery(retail, "  RETAIL   TRADE ")).toBe(true);
  });

  it("matches a word inside a multi-word name", () => {
    expect(industryMatchesQuery(marine, "uphol")).toBe(true);
  });

  it("does not match an unrelated query", () => {
    expect(industryMatchesQuery(retail, "automotive")).toBe(false);
  });

  it("keeps every row for an empty query", () => {
    expect(industryMatchesQuery(marine, "   ")).toBe(true);
  });
});

describe("matchingIndustryAlias", () => {
  it("names the alias that made the row match", () => {
    expect(matchingIndustryAlias(retail, "trade")).toBe("Retail trade");
  });

  it("returns null when the name itself matched, even if an alias also would", () => {
    expect(matchingIndustryAlias(retail, "retail")).toBeNull();
  });

  it("returns null for a query that matches nothing", () => {
    expect(matchingIndustryAlias(retail, "automotive")).toBeNull();
  });
});

describe("industryEqualsQuery", () => {
  it("is true for the exact name", () => {
    expect(industryEqualsQuery(retail, "retail")).toBe(true);
  });

  it("is true for an exact alias — this is what suppresses \"Create ...\"", () => {
    expect(industryEqualsQuery(retail, "  retail   TRADE  ")).toBe(true);
  });

  it("is false for a partial match", () => {
    expect(industryEqualsQuery(retail, "retai")).toBe(false);
  });

  it("is false for an empty query", () => {
    expect(industryEqualsQuery(retail, "")).toBe(false);
  });
});
