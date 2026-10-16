import { describe, expect, it } from "vitest";
import { quoteTermsSchema } from "@/lib/validation/quote-documents";
import { termFigureError } from "@/lib/validation/quote-terms-client";

const figure = quoteTermsSchema.shape.deliveryWeeks;

const inputs: unknown[] = ["", "  ", null, undefined, "0", 0, "12", " 12 ", "1e2", "12.5", "12abc", "-1", "999", "1000", "abc", 2 ** 53, "Infinity", "NaN"];

describe("termFigureError agrees with quoteTermsSchema's figure rule", () => {
  it.each(inputs.map((input, i) => [i, input] as const))("input %i", (_, input) => {
    const zod = figure.safeParse(input);
    const hand = termFigureError(input);
    if (zod.success) expect(hand).toBeNull();
    else expect(hand).toBe(zod.error.issues[0]?.message);
  });
});
