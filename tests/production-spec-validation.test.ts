import { describe, it, expect } from "vitest";
import {
  mSeriesSpecSchema,
  easyLoaderSpecSchema,
  fabricProSpecSchema,
  missingKeys,
} from "../src/lib/validation/production-spec";
import { accepts, expectInvalid, expectValid, rejects } from "./helpers/schema";

const validMSeries = {
  ui: "+Y",
  knifeSize: "1.5x5.0",
  drills: { required: true, detail: "2 x 6mm" },
};

describe("mSeriesSpecSchema", () => {
  accepts(mSeriesSpecSchema, [
    ["a complete spec", validMSeries],
    ["drills declared as not required with no detail", { ...validMSeries, drills: { required: false, detail: "" } }],
    ["special notes at the width measured in the spike", { ...validMSeries, specialNotes: "x".repeat(28) }],
    [
      "drill detail at the width measured in the spike",
      { ...validMSeries, drills: { required: true, detail: "x".repeat(22) } },
    ],
  ]);

  it("defaults the screen side to -Y when omitted, so an untouched panel still prints the standard", () => {
    const withoutUi = { knifeSize: validMSeries.knifeSize, drills: validMSeries.drills };
    const result = mSeriesSpecSchema.safeParse(withoutUi);
    expect(result.success).toBe(true);
    expect(result.success && result.data.ui).toBe("-Y");
  });

  rejects(mSeriesSpecSchema, [
    ["an unknown screen side", { ...validMSeries, ui: "+X" }],
    ["an unknown knife size", { ...validMSeries, knifeSize: "9x9" }],
    ["drills required with an empty detail", { ...validMSeries, drills: { required: true, detail: "   " } }],
    ["special notes beyond the width measured in the spike", { ...validMSeries, specialNotes: "x".repeat(29) }],
    [
      "drill detail beyond the width measured in the spike",
      { ...validMSeries, drills: { required: true, detail: "x".repeat(23) } },
    ],
  ]);
});

describe("the one-field-at-a-time writes ProductionSpecEditor sends", () => {
  // The editor has no Save button: every control spreads the value that just
  // changed over the spec already stored and posts the whole object to
  // `setProductionSpec`. On an item whose `productionSpec` column is still
  // null, "already stored" is `{}` -- so the first field a manager touches
  // arrives entirely on its own. These schemas therefore have to describe a
  // spec being filled in, not a finished one; what stands between a
  // half-answered spec and a printed works order is `missingKeys` against
  // the form's `requires`, asserted at the bottom of this file.
  accepts(mSeriesSpecSchema, [
    ["a knife size chosen first on an item with no spec yet", { knifeSize: "1.5x5.0" }],
    ["a voltage chosen first on an item with no spec yet", { voltage: "400V" }],
    ["a screen side changed first on an item with no spec yet", { ui: "+Y" }],
    ["drills answered first on an item with no spec yet", { drills: { required: false, detail: "" } }],
  ]);

  // The same defect reached FabricPro through its required `travelPlatform`:
  // its rail lengths sit below the screen side, so either of those saved
  // first arrives without it.
  accepts(fabricProSpecSchema, [
    ["a rail length entered first on an item with no spec yet", { railLengthM: 4.5 }],
  ]);

  it("still refuses a field that is present but wrong, whatever else is absent", () => {
    // Optional is not unvalidated: a knife size the price list has never
    // heard of is a bad write no matter how empty the rest of the spec is.
    expectInvalid(mSeriesSpecSchema, { knifeSize: "9x9" });
  });

  it("leaves an untouched required field absent rather than inventing one", () => {
    // Nothing may fill `drills` in on the manager's behalf. `missingKeys`
    // reads an explicit `required: false` as "asked and answered", so a
    // default here would quietly tell the workshop a question had been put
    // to the customer that never was.
    const parsed = expectValid(mSeriesSpecSchema, { knifeSize: "1.5x5.0" });
    expect(parsed).not.toHaveProperty("drills");
    expect(missingKeys(parsed, ["knifeSize", "drills"])).toEqual(["drills"]);
  });
});

describe("easyLoaderSpecSchema", () => {
  accepts(easyLoaderSpecSchema, [
    [
      "up to three table sections",
      {
        ui: "-Y",
        usage: "onload",
        sections: [
          { lengthM: 2.4, surface: "static" },
          { lengthM: 2.4, surface: "conveyor" },
        ],
      },
    ],
    [
      "four table sections",
      { ui: "-Y", usage: "onload", sections: new Array(4).fill({ lengthM: 1.2, surface: "static" }) },
    ],
  ]);

  // Four is the owner's number, and the builder draws exactly four rows.
  it("rejects a fifth table section", () => {
    const result = easyLoaderSpecSchema.safeParse({
      ui: "-Y",
      usage: "onload",
      sections: new Array(5).fill({ lengthM: 1.2, surface: "static" }),
    });
    expect(result.success).toBe(false);
  });

  rejects(easyLoaderSpecSchema, [
    [
      "more than four roll-feed distances",
      {
        ui: "-Y",
        usage: "offload",
        sections: [{ lengthM: 1.2, surface: "static" }],
        rollFeed: { qty: 5, distancesMm: [1, 2, 3, 4, 5] },
      },
    ],
  ]);

  it("defaults screen side to -Y and usage to onload, and sections to an undivided table, when parsing an empty spec", () => {
    const result = easyLoaderSpecSchema.safeParse({});
    expect(result.success).toBe(true);
    expect(result.success && result.data).toEqual({
      ui: "-Y",
      usage: "onload",
      sections: [],
      fabricProCompatible: false,
    });
  });

  it("no longer accepts paperRollHolder or crate -- they moved to the quote as options", () => {
    // Zod 4 objects default to "strip" mode: unknown keys are dropped rather
    // than rejected, so a spec saved before this change still parses -- it
    // just loses the two fields nobody reads anymore.
    const result = easyLoaderSpecSchema.safeParse({
      ui: "-Y",
      usage: "onload",
      sections: [],
      paperRollHolder: true,
      crate: true,
    });
    expect(result.success).toBe(true);
    expect(result.success && result.data).not.toHaveProperty("paperRollHolder");
    expect(result.success && result.data).not.toHaveProperty("crate");
  });
});

describe("fabricProSpecSchema", () => {
  accepts(fabricProSpecSchema, [["a minimal spec", { ui: "+Y", travelPlatform: true }]]);

  it("defaults the screen side to -Y when omitted", () => {
    const result = fabricProSpecSchema.safeParse({ travelPlatform: true });
    expect(result.success).toBe(true);
    expect(result.success && result.data.ui).toBe("-Y");
  });
});

describe("missingKeys", () => {
  it("reports nothing when every required key is present", () => {
    expect(missingKeys(validMSeries, ["ui", "knifeSize", "drills"])).toEqual([]);
  });

  it("reports an absent key", () => {
    expect(missingKeys({ ui: "+Y" }, ["ui", "knifeSize"])).toEqual(["knifeSize"]);
  });

  it("reports every key when the spec is null", () => {
    expect(missingKeys(null, ["ui", "knifeSize"])).toEqual(["ui", "knifeSize"]);
  });

  it("treats drills required with a blank detail as missing", () => {
    const spec = { ui: "+Y", knifeSize: "1.5x5.0", drills: { required: true, detail: "" } };
    expect(missingKeys(spec, ["drills"])).toEqual(["drills"]);
  });

  it("treats drills required=false as satisfied", () => {
    const spec = { drills: { required: false, detail: "" } };
    expect(missingKeys(spec, ["drills"])).toEqual([]);
  });

  it("treats an empty sections array as missing", () => {
    expect(missingKeys({ sections: [] }, ["sections"])).toEqual(["sections"]);
  });
});
