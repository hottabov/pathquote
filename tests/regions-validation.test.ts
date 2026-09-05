import { describe, it, expect } from "vitest";
import {
  regionCodeSchema,
  currencyCodeSchema,
  regionNameSchema,
  taxNameSchema,
  taxRateSchema,
  entityNameSchema,
  entityLegalIdSchema,
  entityAddressSchema,
  footerTextSchema,
  bankDetailsRecordSchema,
  bankDetailsSchema,
  createRegionSchema,
  updateRegionSchema,
} from "../src/lib/validation/regions";
import { accepts, rejects } from "./helpers/schema";

describe("regionCodeSchema", () => {
  accepts(regionCodeSchema, [
    ["a lowercase code, normalized to uppercase", "au", "AU"],
    ["a 2-letter code", "AU"],
    ["a 3-letter code", "USA"],
  ]);

  rejects(regionCodeSchema, [
    ["a code with digits", "A1"],
    ["a 1-letter code", "A"],
    ["a 4-letter code", "ABCD"],
    ["a blank code", ""],
  ]);
});

describe("currencyCodeSchema", () => {
  accepts(currencyCodeSchema, [
    ["a lowercase code, normalized to uppercase", "aud", "AUD"],
    ["exactly 3 letters", "USD"],
  ]);

  rejects(currencyCodeSchema, [
    ["2 letters", "US"],
    ["4 letters", "USDD"],
    ["digits", "US1"],
  ]);
});

describe("regionNameSchema", () => {
  accepts(regionNameSchema, [["a normal name", "Australia"]]);

  rejects(regionNameSchema, [
    ["a name shorter than 2 characters", "A"],
    ["a name over 200 characters", "A".repeat(201)],
  ]);
});

describe("taxNameSchema", () => {
  accepts(taxNameSchema, [
    ["a normal tax name", "GST"],
    ["a tax name at exactly the 40 character bound", "A".repeat(40)],
  ]);

  rejects(taxNameSchema, [
    ["an empty tax name", ""],
    ["a tax name over 40 characters", "A".repeat(41)],
  ]);
});

describe("taxRateSchema", () => {
  accepts(taxRateSchema, [
    ["a whole number rate", "10"],
    ["a rate with 1 decimal place", "10.5"],
    ["a rate with 2 decimal places", "10.55"],
    ["zero", "0"],
    ["the upper bound 99.99", "99.99"],
  ]);

  rejects(taxRateSchema, [
    ["a rate over 99.99", "100"],
    ["more than 2 decimal places", "10.555"],
    ["a negative rate", "-1"],
    ["a non-numeric value", "ten"],
  ]);
});

describe("entityNameSchema", () => {
  accepts(entityNameSchema, [["a normal entity name", "Pathfinder Australia Pty Ltd"]]);

  rejects(entityNameSchema, [
    ["an empty entity name", ""],
    ["an entity name over 200 characters", "A".repeat(201)],
  ]);
});

describe("optional entity/footer fields", () => {
  it("collapses missing/blank entityLegalId to undefined", () => {
    for (const value of [undefined, null, "", "   "]) {
      const result = entityLegalIdSchema.safeParse(value);
      expect(result.success).toBe(true);
      if (result.success) expect(result.data).toBeUndefined();
    }
  });

  rejects(entityLegalIdSchema, [["entityLegalId over 100 characters", "A".repeat(101)]]);
  rejects(entityAddressSchema, [["entityAddress over 400 characters", "A".repeat(401)]]);

  accepts(footerTextSchema, [["footerText at exactly the 2000 character bound", "A".repeat(2000)]]);
  rejects(footerTextSchema, [["footerText over 2000 characters", "A".repeat(2001)]]);
});

describe("bankDetailsRecordSchema", () => {
  const record = (count: number) =>
    Object.fromEntries(Array.from({ length: count }, (_, i) => [`Key ${i}`, "value"]));

  accepts(bankDetailsRecordSchema, [
    ["an empty record", {}],
    ["a normal record", { "Account name": "Pathfinder", BSB: "123-456" }],
    ["exactly 12 keys", record(12)],
    ["a key at exactly 40 characters", { ["A".repeat(40)]: "value" }],
    ["a value at exactly 120 characters", { Key: "A".repeat(120) }],
  ]);

  rejects(bankDetailsRecordSchema, [
    ["more than 12 keys", record(13)],
    ["a key over 40 characters", { ["A".repeat(41)]: "value" }],
    ["a value over 120 characters", { Key: "A".repeat(121) }],
    ["a non-string value", { Key: 123 }],
  ]);
});

describe("bankDetailsSchema", () => {
  it("collapses missing/blank input to null", () => {
    for (const value of [undefined, null, "", "   "]) {
      const result = bankDetailsSchema.safeParse(value);
      expect(result.success).toBe(true);
      if (result.success) expect(result.data).toBeNull();
    }
  });

  it("parses valid JSON into a record", () => {
    const result = bankDetailsSchema.safeParse(JSON.stringify({ BSB: "123-456" }));
    expect(result.success).toBe(true);
    if (result.success) expect(result.data).toEqual({ BSB: "123-456" });
  });

  it("rejects invalid JSON", () => {
    expect(bankDetailsSchema.safeParse("{not json").success).toBe(false);
  });

  it("rejects JSON that isn't an object (e.g. an array)", () => {
    expect(bankDetailsSchema.safeParse(JSON.stringify(["a", "b"])).success).toBe(false);
  });

  it("rejects a JSON object with more than 12 keys", () => {
    const obj = Object.fromEntries(Array.from({ length: 13 }, (_, i) => [`Key ${i}`, "value"]));
    expect(bankDetailsSchema.safeParse(JSON.stringify(obj)).success).toBe(false);
  });
});

describe("createRegionSchema", () => {
  const base = {
    code: "AU",
    name: "Australia",
    currency: "AUD",
    taxName: "GST",
    taxRate: "10.00",
    entityName: "Pathfinder Australia Pty Ltd",
    entityLegalId: "ABN 64 072 458 667",
    entityAddress: "1 Example St, Sydney",
    footerText: "Thanks for your business.",
    bankDetails: JSON.stringify({ BSB: "123-456" }),
    maxDiscountPct: "10",
    active: "on",
  };

  it("accepts a fully populated valid submission", () => {
    const result = createRegionSchema.safeParse(base);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.code).toBe("AU");
      expect(result.data.active).toBe(true);
      expect(result.data.bankDetails).toEqual({ BSB: "123-456" });
      expect(result.data.maxDiscountPct).toBe(10);
    }
  });

  it("treats a missing/blank maxDiscountPct as no cap (null)", () => {
    const withoutCap = Object.fromEntries(
      Object.entries(base).filter(([key]) => key !== "maxDiscountPct")
    );
    const result = createRegionSchema.safeParse(withoutCap);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.maxDiscountPct).toBeNull();

    const blank = createRegionSchema.safeParse({ ...base, maxDiscountPct: "" });
    expect(blank.success).toBe(true);
    if (blank.success) expect(blank.data.maxDiscountPct).toBeNull();
  });

  it("rejects a maxDiscountPct above 100", () => {
    expect(createRegionSchema.safeParse({ ...base, maxDiscountPct: "101" }).success).toBe(false);
  });

  it("accepts omitted optional fields", () => {
    const result = createRegionSchema.safeParse({
      ...base,
      entityLegalId: "",
      entityAddress: "",
      footerText: "",
      bankDetails: "",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.entityLegalId).toBeUndefined();
      expect(result.data.bankDetails).toBeNull();
    }
  });

  it("treats a missing active checkbox as false", () => {
    const rest = Object.fromEntries(Object.entries(base).filter(([key]) => key !== "active"));
    const result = createRegionSchema.safeParse(rest);
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.active).toBe(false);
  });

  it("rejects an invalid code", () => {
    expect(createRegionSchema.safeParse({ ...base, code: "A1" }).success).toBe(false);
  });

  it("rejects an invalid tax rate", () => {
    expect(createRegionSchema.safeParse({ ...base, taxRate: "100" }).success).toBe(false);
  });
});

describe("updateRegionSchema", () => {
  const base = {
    name: "Australia",
    currency: "AUD",
    taxName: "GST",
    taxRate: "10.00",
    entityName: "Pathfinder Australia Pty Ltd",
    entityLegalId: "",
    entityAddress: "",
    footerText: "",
    bankDetails: "",
    maxDiscountPct: "15",
    active: "on",
  };

  it("has no `code` field at all", () => {
    expect("code" in updateRegionSchema.shape).toBe(false);
  });

  it("accepts a fully populated valid submission", () => {
    expect(updateRegionSchema.safeParse(base).success).toBe(true);
  });

  it("ignores an extraneous code field rather than erroring", () => {
    const result = updateRegionSchema.safeParse({ ...base, code: "US" });
    expect(result.success).toBe(true);
    if (result.success) expect((result.data as Record<string, unknown>).code).toBeUndefined();
  });
});
