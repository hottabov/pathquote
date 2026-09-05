import { describe, it, expect } from "vitest";
import { industryNameSchema, normalizeIndustryName } from "../src/lib/validation/industries";
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
