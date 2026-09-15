import { describe, it, expect } from "vitest";
import { buildPatches, unmatchedOptions } from "../src/lib/production-forms/resolve";
import { formContext, formItem, xlsxForm } from "./helpers/fixtures";

const spec = xlsxForm("EASYLOADER");

const rollFeedOption = (qty: number) => ({
  id: "opt-rf",
  code: "EL-2420-RF",
  role: "EL_ROLL_FEED" as const,
  qty,
  attributes: null,
});

const context = (options: ReturnType<typeof rollFeedOption>[], distancesMm?: number[]) =>
  formContext({
    item: formItem({
      code: "EL-2420",
      form: "EASYLOADER",
      specs: { tableWidthMm: 2420 },
      spec: {
        usage: "onload",
        sections: [{ lengthM: 2.4, surface: "conveyor" }],
        ...(distancesMm ? { rollFeedDistancesMm: distancesMm } : {}),
      },
      options,
    }),
  });

const patchFor = (cell: string, patches: { cell: string; value: string }[]) =>
  patches.find((patch) => patch.cell === cell)?.value;

describe("EasyLoader roll feed", () => {
  it("ticks the row and prints the quantity from the option line, not the spec", () => {
    const patches = buildPatches(spec, context([rollFeedOption(2)], [300, 1500]));

    expect(patchFor("D59", patches)).toBe("X");
    expect(patchFor("F61", patches)).toBe("2");
  });

  it("prints each distance in its own printed row", () => {
    const patches = buildPatches(spec, context([rollFeedOption(3)], [300, 1500, 2700]));

    expect(patchFor("K61", patches)).toBe("300");
    expect(patchFor("K63", patches)).toBe("1500");
    expect(patchFor("K65", patches)).toBe("2700");
    expect(patchFor("K67", patches)).toBeUndefined();
  });

  it("leaves the row untouched when no attachment was sold", () => {
    const patches = buildPatches(spec, context([]));

    expect(patchFor("D59", patches)).toBeUndefined();
    expect(patchFor("F61", patches)).toBeUndefined();
  });

  it("keeps a sold attachment off the Additional items sheet", () => {
    const unmatched = unmatchedOptions(spec, context([rollFeedOption(1)]));

    expect(unmatched.map((option) => option.code)).toEqual([]);
  });

  it("still prints the distances a spec carries for an attachment bought earlier", () => {
    // The customer owns the attachment already, so no option line -- the row
    // is not ticked, but the distances the service crew needs still print.
    const patches = buildPatches(spec, context([], [300]));

    expect(patchFor("D59", patches)).toBeUndefined();
    expect(patchFor("K61", patches)).toBe("300");
  });
});
