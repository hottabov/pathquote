import { describe, it, expect } from "vitest";
import {
  quoteValidityDaysSchema,
  showOptionIconsSchema,
  commissionTiersSchema,
  isAllowedSettingKey,
  ALLOWED_SETTING_KEYS,
} from "../src/lib/validation/settings";
import { DEFAULT_COMMISSION_TIERS } from "../src/lib/pricing";
import { accepts, rejects } from "./helpers/schema";

describe("quoteValidityDaysSchema", () => {
  accepts(quoteValidityDaysSchema, [
    ["the lower bound (1) as a number", 1],
    ["the lower bound (1) as a string", "1"],
    ["the upper bound (365)", 365],
    ["a typical value (7), coerced to a number", "7", 7],
  ]);

  rejects(quoteValidityDaysSchema, [
    ["0", 0],
    ["a negative number", -5],
    ["a value over 365", 366],
    ["a non-integer", 7.5],
    ["a non-numeric string", "not-a-number"],
  ]);

  it("rejects null", () => {
    // Coerced via Number(null) === 0, which then fails the min(1) bound —
    // still a rejection, just via the range check rather than a type error.
    expect(quoteValidityDaysSchema.safeParse(null).success).toBe(false);
  });
});

describe("showOptionIconsSchema", () => {
  accepts(showOptionIconsSchema, [
    ["the literal string \"true\", transformed to boolean true", "true", true],
    ["the literal string \"false\", transformed to boolean false", "false", false],
  ]);

  rejects(showOptionIconsSchema, [
    ["a native boolean true (only the two literal strings are accepted)", true],
    ["a native boolean false (only the two literal strings are accepted)", false],
    ["an arbitrary string", "on"],
    ["an empty string", ""],
    ["null", null],
    ["undefined", undefined],
  ]);
});

describe("commissionTiersSchema", () => {
  accepts(commissionTiersSchema, [
    ["the default table as JSON", JSON.stringify(DEFAULT_COMMISSION_TIERS), DEFAULT_COMMISSION_TIERS],
    ["an empty array (clearing the table)", "[]", []],
  ]);

  rejects(commissionTiersSchema, [
    ["text that isn't valid JSON", "not json"],
    ["JSON that isn't an array of tier rows (an object)", '{"minPct":0}'],
    [
      "JSON that isn't an array of tier rows (wrong field types)",
      '[{"minPct":"0","maxPct":null,"ratePct":5}]',
    ],
    [
      "a table with a gap, surfacing validateCommissionTiers's message",
      JSON.stringify([
        { minPct: 0, maxPct: 5, ratePct: 5 },
        { minPct: 6, maxPct: null, ratePct: 4 },
      ]),
      "gap",
    ],
    [
      "a table not starting at 0%",
      JSON.stringify([{ minPct: 1, maxPct: null, ratePct: 5 }]),
      "start at 0",
    ],
  ]);
});

describe("isAllowedSettingKey", () => {
  it("accepts every key in ALLOWED_SETTING_KEYS", () => {
    for (const key of ALLOWED_SETTING_KEYS) {
      expect(isAllowedSettingKey(key)).toBe(true);
    }
  });

  it("rejects an arbitrary key", () => {
    expect(isAllowedSettingKey("quote.validityDays; DROP TABLE")).toBe(false);
    expect(isAllowedSettingKey("some.other.key")).toBe(false);
    expect(isAllowedSettingKey("")).toBe(false);
  });
});
