import { describe, it, expect } from "vitest";
import { seriesQuoteDescriptionSchema } from "../src/lib/validation/series";

describe("seriesQuoteDescriptionSchema", () => {
  it("accepts empty, meaning the category prints nothing", () => {
    expect(seriesQuoteDescriptionSchema.parse("")).toBeNull();
    expect(seriesQuoteDescriptionSchema.parse("   ")).toBeNull();
  });

  // The inputs above are the two the editor can never actually produce.
  // Tiptap's `getHTML()` returns `<p></p>` for an empty document, never "",
  // so these are the shapes that reach the action when an author types
  // something and deletes it -- and the shape already sitting in the repo's
  // own real-data fixture (tests/fixtures/catalog-dump.json).
  it("treats a body with no visible text as empty", () => {
    expect(seriesQuoteDescriptionSchema.parse("<p></p>")).toBeNull();
    expect(seriesQuoteDescriptionSchema.parse("<p><br></p>")).toBeNull();
    expect(seriesQuoteDescriptionSchema.parse("<p>&nbsp;</p>")).toBeNull();
    expect(seriesQuoteDescriptionSchema.parse("<p></p><p><br></p>")).toBeNull();
    expect(seriesQuoteDescriptionSchema.parse("<p>&nbsp;</p><p><br /></p>")).toBeNull();
  });

  it("keeps a body whose only visible text is inside a tag", () => {
    expect(seriesQuoteDescriptionSchema.parse("<p><strong>A</strong></p>")).toBe("<p><strong>A</strong></p>");
  });

  it("accepts ordinary copy", () => {
    expect(seriesQuoteDescriptionSchema.parse("<p>Copy.</p>")).toBe("<p>Copy.</p>");
  });

  it("rejects a body over 20000 characters", () => {
    expect(() => seriesQuoteDescriptionSchema.parse("x".repeat(20001))).toThrow();
  });
});
