import { describe, expect, it } from "vitest";
import { productSpecsSchema, readProductSpecs as readWithZod } from "@/lib/validation/product-specs";
import { parseProductSpecs, readProductSpecs } from "@/lib/validation/product-specs-client";

const inputs: unknown[] = [
  {},
  null,
  undefined,
  [],
  "x",
  { cutHeightCm: 2.5 },
  { cutHeightCm: 0 },
  { cutHeightCm: "2" },
  { cutWidthCm: 180 },
  { tableWidthMm: 1800 },
  { tableWidthMm: 1800.5 },
  { tableWidthMm: -1 },
  { paperWidthMm: 2 ** 53 },
  { modelTier: "180" },
  { modelTier: "" },
  { widthCode: 220 },
  { extended: true },
  { extended: "true" },
  { belt: "felt" },
  { belt: "leather" },
  { softwareMode: "integrated" },
  { softwareMode: "cloud" },
  { pathworksModule: "ANT_V6" },
  { pathworksModule: "ANT_V7" },
  { unknownKey: 1 },
  { cutHeightCm: 2.5, belt: "urethane", unknownKey: 1 },
  { cutHeightCm: undefined },
  { cutHeightCm: 5, cutWidthCm: 180, tableWidthMm: 1800, modelTier: "220", widthCode: 220, extended: false, belt: "urethane", softwareMode: "standalone", pathworksModule: "PDG" },
];

describe("parseProductSpecs agrees with productSpecsSchema", () => {
  it.each(inputs.map((input, i) => [i, input] as const))("input %i", (_, input) => {
    const zod = productSpecsSchema.safeParse(input);
    const hand = parseProductSpecs(input);
    if (zod.success) expect(hand).toEqual(zod.data);
    else expect(hand).toBeNull();
  });

  it("readProductSpecs falls back to {} exactly as the zod reader does", () => {
    for (const input of inputs) expect(readProductSpecs(input)).toEqual(readWithZod(input));
  });
});
