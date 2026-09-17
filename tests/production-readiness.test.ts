import { describe, it, expect } from "vitest";
import { MTS_METRES_REQUIRED, mtsMetresValid } from "../src/lib/production-forms/mts";
import { describeIssues, itemMissing, productionIssues } from "../src/lib/production-forms/readiness";

const mSeries = (productionSpec: unknown, options: Array<{ role: "MTS" | "HDC"; attributes: unknown }> = []) => ({
  code: "M-7220",
  form: "M_SERIES" as const,
  productionSpec,
  options,
});

const complete = { knifeSize: "1.5x7.0" };

describe("mtsMetresValid", () => {
  it.each([
    [{ metres: 12 }, true],
    [{ metres: "4.5" }, true],
    [{ metres: 0 }, false],
    [{ metres: -3 }, false],
    [{ metres: "" }, false],
    [{}, false],
    [null, false],
  ])("%j -> %s", (attributes, valid) => {
    expect(mtsMetresValid(attributes)).toBe(valid);
  });

  it("has a message the builder and the action share", () => {
    expect(MTS_METRES_REQUIRED).toMatch(/MTS travel distance/);
  });
});

describe("productionIssues", () => {
  it("reports nothing for a complete item", () => {
    expect(productionIssues([mSeries(complete, [{ role: "MTS", attributes: { metres: 12 } }])])).toEqual([]);
  });

  it("reports an MTS with no travel distance", () => {
    expect(itemMissing(mSeries(complete, [{ role: "MTS", attributes: null }]))).toEqual(["mtsTravel"]);
  });

  it("does not ask for a distance when no MTS was sold", () => {
    expect(itemMissing(mSeries(complete, [{ role: "HDC", attributes: null }]))).toEqual([]);
  });

  it("reports the form's own requirements, including drills ticked with no detail", () => {
    const issues = productionIssues([
      mSeries({ drills: { required: true, detail: "" } }, [{ role: "MTS", attributes: {} }]),
    ]);
    expect(issues).toEqual([{ code: "M-7220", missing: ["knifeSize", "drills", "mtsTravel"] }]);
    expect(describeIssues(issues)).toBe("M-7220: knife size, drill details, MTS travel (m)");
  });

  it("ignores items with no production form", () => {
    expect(productionIssues([{ code: "PTW-S", form: null, productionSpec: null, options: [] }])).toEqual([]);
  });
});
