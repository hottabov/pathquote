import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { FORM_SHEET_CSS } from "../src/components/forms/form-sheet-css";

/**
 * Rules the sheets depend on structurally, rather than for looks. A value
 * changed by accident here does not fail a render test -- the markup is
 * identical either way -- so they are asserted on the stylesheet itself.
 */
describe("the form stylesheet", () => {
  it("is one template literal whose only bare backticks are its delimiters", () => {
    // An UNESCAPED backtick in a comment in that file ends the string and
    // breaks every form at build time. It has happened twice, both times in
    // a comment naming a CSS property. Escaped ones are fine, which is why
    // this reads the source rather than the exported string.
    const source = readFileSync(
      path.resolve(__dirname, "../src/components/forms/form-sheet-css.ts"),
      "utf8"
    );
    // Only the string itself: the file's own header comment quotes CSS terms
    // in backticks quite legally, above the literal.
    const literal = source.slice(source.indexOf("export const FORM_SHEET_CSS ="));
    const bare = [...literal.matchAll(/(^|[^\\])`/g)];
    expect(bare).toHaveLength(2);
    expect(FORM_SHEET_CSS.length).toBeGreaterThan(1000);
  });

  it("lays the sheet out as a column so the office block can sink to the foot", () => {
    const sheet = FORM_SHEET_CSS.slice(FORM_SHEET_CSS.indexOf(".pf-sheet {"));
    expect(sheet).toMatch(/display:\s*flex/);
    expect(sheet).toMatch(/flex-direction:\s*column/);
  });

  it("pins Office use only to the bottom of every sheet, dense ones included", () => {
    const office = FORM_SHEET_CSS.slice(
      FORM_SHEET_CSS.indexOf(".pf-office {"),
      FORM_SHEET_CSS.indexOf(".pf-office > h2")
    );
    expect(office).toMatch(/margin-top:\s*auto/);

    // The dense (L-Series) override must not set a margin-top of its own:
    // a fixed value there would unpin the block again.
    const dense = FORM_SHEET_CSS.slice(FORM_SHEET_CSS.indexOf(".pf-sheet.pf-dense .pf-office"));
    expect(dense.slice(0, dense.indexOf("}"))).not.toMatch(/margin-top/);
  });

  it("keeps sheet blocks at their own height, so a full sheet is not squeezed", () => {
    expect(FORM_SHEET_CSS).toMatch(/\.pf-sheet > \*\s*\{\s*flex:\s*0 0 auto/);
  });
});
