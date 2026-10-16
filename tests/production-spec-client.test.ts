import { describe, expect, it } from "vitest";
import { easyLoaderSpecSchema, screenSideSchema } from "@/lib/validation/production-spec";
import { parseEasyLoaderSpec, readScreenSide } from "@/lib/validation/production-spec-client";

// The zod-free readers the builder's client components use must give the
// same answers as the zod schemas the server runs. Each table row is one
// input; the two sides are compared structurally.

const easyLoaderInputs: unknown[] = [
  {},
  null,
  undefined,
  "nope",
  [],
  { ui: "+Y" },
  { ui: "sideways" },
  { usage: "offload" },
  { usage: "sideways" },
  { customWidthMm: 1200 },
  { customWidthMm: 0 },
  { customWidthMm: 10000 },
  { customWidthMm: 12.5 },
  { customWidthMm: "1200" },
  { customWidthMm: 2 ** 53 },
  { sections: [] },
  { sections: [{ lengthM: 2, surface: "static" }] },
  { sections: [{ lengthM: 0, surface: "static" }] },
  { sections: [{ lengthM: 100, surface: "static" }] },
  { sections: [{ lengthM: 2, surface: "rubber" }] },
  { sections: [{ lengthM: 2 }] },
  { sections: "two" },
  { sections: Array.from({ length: 7 }, () => ({ lengthM: 1, surface: "conveyor" })) },
  { fabricProCompatible: true },
  { fabricProCompatible: "yes" },
  { syncWithCutter: false },
  { syncWithCutter: 0 },
  { rollFeedDistancesMm: [0, 99999] },
  { rollFeedDistancesMm: [-1] },
  { rollFeedDistancesMm: [100000] },
  { rollFeedDistancesMm: [1.5] },
  { rollFeedDistancesMm: [1, 2, 3, 4, 5] },
  { rollFeedDistancesMm: "far" },
  { ui: "-Y", usage: "onload", customWidthMm: 900, sections: [{ lengthM: 3.5, surface: "conveyor" }], stray: 1 },
  { ui: NaN },
  { customWidthMm: Number.POSITIVE_INFINITY },
];

describe("parseEasyLoaderSpec agrees with easyLoaderSpecSchema", () => {
  it.each(easyLoaderInputs.map((input, i) => [i, input] as const))("input %i", (_, input) => {
    const zod = easyLoaderSpecSchema.safeParse(input);
    const hand = parseEasyLoaderSpec(input);
    if (zod.success) expect(hand).toEqual(zod.data);
    else expect(hand).toBeNull();
  });
});

describe("readScreenSide agrees with screenSideSchema", () => {
  it.each([[null], [undefined], [{}], [{ ui: "+Y" }], [{ ui: "-Y" }], [{ ui: "x" }], [{ ui: 1 }], ["str"]])(
    "spec %j",
    (spec) => {
      const ui = (spec as { ui?: unknown } | null | undefined)?.ui;
      const zod = screenSideSchema.safeParse(ui);
      expect(readScreenSide(spec)).toBe(zod.success ? zod.data : "-Y");
    }
  );
});
