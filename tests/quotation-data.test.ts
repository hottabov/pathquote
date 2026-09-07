import { describe, it, expect } from "vitest";
import {
  buildQuotationData,
  dedupeOptionCode,
  OMIT,
  resolveBlocks,
  substitutePlaceholders,
  substituteWithReport,
  type ContentBlockRow,
  type QuotationItemInput,
} from "../src/lib/quotation-data";
import { CATEGORY_TOKENS } from "../src/lib/quote-variables";
import type { OptionRole } from "@prisma/client";
// The downstream repair `htmlBlockLines`'s doc comment relies on — see the
// nested-list test below.
import { renderStoredRichText } from "../src/lib/rich-text";
import { quotationDoc, quotationItem } from "./helpers/fixtures";

// Pure module — no @/lib/db import (see quotation-data.ts's header comment),
// so this never needs DATABASE_URL set, same as tests/sheet-data.test.ts.

describe("resolveBlocks — precedence", () => {
  const blocks: ContentBlockRow[] = [
    { key: "terms.delivery", regionId: null, title: "Delivery", body: "Default delivery body", sortOrder: 1 },
    { key: "terms.delivery", regionId: "region-us", title: "Delivery (US)", body: "US delivery body", sortOrder: 1 },
    { key: "terms.warranty", regionId: null, title: "Warranty", body: "Default warranty body", sortOrder: 2 },
  ];

  it("uses the default (regionId: null) row when the region has no override", () => {
    const resolved = resolveBlocks(blocks, "region-au");
    expect(resolved.get("terms.delivery")?.body).toBe("Default delivery body");
    expect(resolved.get("terms.warranty")?.body).toBe("Default warranty body");
  });

  it("prefers a region-specific override over the default for the same key", () => {
    const resolved = resolveBlocks(blocks, "region-us");
    expect(resolved.get("terms.delivery")?.body).toBe("US delivery body");
    // Unrelated key still falls back to its default.
    expect(resolved.get("terms.warranty")?.body).toBe("Default warranty body");
  });

  it("ignores a different region's override entirely", () => {
    const resolved = resolveBlocks(blocks, "region-uk");
    expect(resolved.get("terms.delivery")?.body).toBe("Default delivery body");
  });
});

describe("substitutePlaceholders", () => {
  it("replaces a known token", () => {
    expect(substitutePlaceholders("Model M{{model}}", { model: "450" })).toBe("Model M450");
  });

  it("replaces multiple distinct tokens in one body", () => {
    expect(substitutePlaceholders("{{a}} and {{b}}", { a: "1", b: "2" })).toBe("1 and 2");
  });

  // --- line-strip rule (owner: raw "____" blanks are never acceptable —
  // fields must fill themselves in automatically; anything this module
  // genuinely can't fill in disappears entirely, one whole line at a time,
  // rather than leaving a fill-in-the-blank marker) -----------------------

  it("strips the entire body when its only line is unresolved", () => {
    expect(substitutePlaceholders("Cost: {{rspUnitCost}}", {})).toBe("");
  });

  it("strips only the line containing an unresolved token, keeping the rest", () => {
    const result = substitutePlaceholders("Line one\nCost: {{rspUnitCost}}\nLine three", {});
    expect(result).toBe("Line one\nLine three");
  });

  it("treats an empty-string value as unresolved too (strips its line)", () => {
    const result = substitutePlaceholders("Keep this\nValue: {{x}}", { x: "" });
    expect(result).toBe("Keep this");
  });

  it("strips a line containing an explicitly OMIT-ed token", () => {
    const result = substitutePlaceholders("Keep this\nPrice: {{price}}\nAlso keep", { price: OMIT });
    expect(result).toBe("Keep this\nAlso keep");
  });

  it("does not strip a line whose token resolved to a non-empty value", () => {
    const result = substitutePlaceholders("Price: {{price}}\nOther line", { price: "$100" });
    expect(result).toBe("Price: $100\nOther line");
  });

  it("passes a multi-line resolved value through as multiple output lines (e.g. bankDetails)", () => {
    const result = substitutePlaceholders("Before\n{{bankDetails}}\nAfter", {
      bankDetails: "Bank: ANZ Westfield\nBSB: 013 442",
    });
    expect(result).toBe("Before\nBank: ANZ Westfield\nBSB: 013 442\nAfter");
  });

  it("strips a line only when it still contains an unresolved token after substituting the rest of it", () => {
    // A line can carry both a resolved and an unresolved token — any single
    // unresolved token strips the whole line, not just its own token.
    const result = substitutePlaceholders("{{known}} plus {{unknown}}\nSafe line", { known: "1" });
    expect(result).toBe("Safe line");
  });

  it("reports the token that caused a line to be stripped", () => {
    const result = substituteWithReport("Kept {{model}}\nGone {{cutHeightCm}}", { model: "M-5180" });
    expect(result.text).toBe("Kept M-5180");
    expect(result.stripped).toEqual(["cutHeightCm"]);
  });

  it("reports nothing when every token resolves", () => {
    const result = substituteWithReport("Kept {{model}}", { model: "M-5180" });
    expect(result.text).toBe("Kept M-5180");
    expect(result.stripped).toEqual([]);
  });

  it("does not report a deliberately withheld token", () => {
    // OMIT means "hidden on purpose right now" (a price with the toggle off),
    // not "we have no data" — surfacing it would cry wolf on every quote
    // that simply hides prices.
    const result = substituteWithReport("Price: {{price}}", { price: OMIT });
    expect(result.text).toBe("");
    expect(result.stripped).toEqual([]);
  });

  it("reports every distinct missing token once", () => {
    const result = substituteWithReport("{{a}}\n{{b}}\n{{a}}", {});
    expect(result.stripped).toEqual(["a", "b"]);
  });

  it("leaves substitutePlaceholders behaving exactly as before", () => {
    expect(substitutePlaceholders("Kept {{model}}\nGone {{x}}", { model: "M" })).toBe("Kept M");
  });
});

// --- the line-strip rule against Tiptap's one-line HTML ---------------------
//
// The strip was written for markdown, where every paragraph, heading and list
// item already sat on its own `\n`-delimited line. Tiptap serialises a whole
// document as ONE line — `<p>A</p><p>B</p><ul><li>C</li></ul>`, no newlines
// anywhere — so splitting that body by `\n` gives a single line, and one
// unresolved token anywhere in it deleted the entire description. These tests
// pin the block-aware behaviour that replaces it.
describe("substituteWithReport — HTML block bodies", () => {
  it("strips only the paragraph holding the unresolved token", () => {
    const result = substituteWithReport("<p>Kept {{model}}</p><p>Gone {{x}}</p>", { model: "M" });
    expect(result.text).toContain("Kept M");
    expect(result.text).toContain("<p>");
    expect(result.text).not.toContain("Gone");
    expect(result.stripped).toEqual(["x"]);
  });

  it("strips one list item and leaves the list itself standing", () => {
    const result = substituteWithReport("<ul><li>Kept</li><li>Gone {{x}}</li></ul>", {});
    expect(result.text).toContain("<ul>");
    expect(result.text).toContain("</ul>");
    expect(result.text).toContain("<li>Kept</li>");
    expect(result.text).not.toContain("Gone");
    expect(result.stripped).toEqual(["x"]);
  });

  it("keeps a heading whose following paragraph is stripped", () => {
    const result = substituteWithReport("<h2>Kept</h2><p>Gone {{x}}</p>", {});
    expect(result.text).toContain("<h2>Kept</h2>");
    expect(result.text).not.toContain("Gone");
  });

  it("strips inside a blockquote without orphaning its closing tag", () => {
    // A blockquote wraps blocks the way a list does: if its opening tag rode
    // on its first paragraph's line, stripping that paragraph would delete
    // the opener and leave `</blockquote>` behind.
    const result = substituteWithReport("<blockquote><p>Keep</p><p>Gone {{x}}</p></blockquote><p>After</p>", {});
    expect(result.text).toContain("<blockquote>");
    expect(result.text).toContain("</blockquote>");
    expect(result.text).toContain("<p>Keep</p>");
    expect(result.text).toContain("<p>After</p>");
    expect(result.text).not.toContain("Gone");
  });

  it("drops a list left holding nothing rather than printing an empty one", () => {
    const result = substituteWithReport("<p>Keep</p><ul><li>{{x}}</li></ul>", {});
    expect(result.text).toContain("<p>Keep</p>");
    expect(result.text).not.toContain("<ul>");
    expect(result.text).not.toContain("</ul>");
  });

  it("leaves a nested list's stray tags for the sanitizer to repair", () => {
    // `htmlBlockLines`'s doc comment names exactly one shape it cannot divide
    // cleanly -- an `<li>` holding both its own text and a nested list -- and
    // says the stray tags it leaves behind are repaired downstream, because
    // every read of this output goes through `renderStoredRichText`. That
    // claim is load-bearing (it is the argument for not carrying a real HTML
    // parser in this pure module) and was untested. So: strip, then render,
    // and check the sanitizer really does hand the page valid markup with the
    // nested item still in it.
    const result = substituteWithReport("<ul><li>A {{x}}<ul><li>B</li></ul></li></ul>", {});
    expect(result.stripped).toEqual(["x"]);
    // The unresolved item's own text is gone; the stray tags are still there.
    expect(result.text).not.toContain("A ");
    expect(result.text).toContain("</li>\n");

    const rendered = renderStoredRichText(result.text);
    expect(rendered).toContain("<li>B</li>");
    expect(rendered).not.toContain("A ");
    // Valid: every tag the sanitizer emitted is balanced, so nothing stray
    // survived to reach the page.
    const count = (html: string, pattern: RegExp) => html.match(pattern)?.length ?? 0;
    expect(count(rendered, /<li>/g)).toBe(count(rendered, /<\/li>/g));
    expect(count(rendered, /<ul>/g)).toBe(count(rendered, /<\/ul>/g));
    expect(count(rendered, /<ul>/g)).toBeGreaterThan(0);
  });

  it("returns nothing when every block holds an unresolved token", () => {
    const result = substituteWithReport("<p>{{a}}</p><p>{{b}}</p>", {});
    expect(result.text).toBe("");
    expect(result.stripped).toEqual(["a", "b"]);
  });

  it("leaves an HTML body with no unresolved tokens intact", () => {
    // The normalisation inserts newlines between tags, which the sanitizer
    // treats as insignificant whitespace — so assert on the tags and text
    // present, not on an exact string.
    const result = substituteWithReport("<h2>Specs</h2><p>The {{model}}.</p><ul><li>One</li><li>Two</li></ul>", {
      model: "M-5180",
    });
    expect(result.text).toContain("<h2>Specs</h2>");
    expect(result.text).toContain("<p>The M-5180.</p>");
    expect(result.text).toContain("<ul>");
    expect(result.text).toContain("<li>One</li>");
    expect(result.text).toContain("<li>Two</li>");
    expect(result.text).toContain("</ul>");
    expect(result.stripped).toEqual([]);
  });

  it("still strips a legacy markdown body one `\\n` line at a time", () => {
    // The regression guard for the pre-Tiptap path: a body with no HTML tags
    // must behave exactly as it did before block-awareness existed.
    const result = substituteWithReport("Line one\nCost: {{x}}\nLine three", {});
    expect(result.text).toBe("Line one\nLine three");
    expect(result.stripped).toEqual(["x"]);
  });
});

// --- buildQuotationData: light integration coverage -------------------------

// One category's quote copy (`Series.quoteDescription`), of the shape the
// M-Series' migrated body has: a spec line plus its own price line.
// `{{price}}` deliberately lives on its own line/paragraph (blank line
// before it) — mirroring the old machine.m-series block's
// "**Price: {{price}}**" paragraph — so hiding the price strips only that
// one line, never the model/height/width line above it.
const mSeriesCopy = "Model {{model}}. Height {{cutHeightCm}}cm, width {{cutWidthCm}}cm.\n\nPrice: {{price}}";

const termsBlock: ContentBlockRow = {
  key: "terms.payment",
  regionId: null,
  title: "Payment",
  body: "EFT details:\n\n{{bankDetails}}",
  sortOrder: 3,
};

const conditionsBlock: ContentBlockRow = {
  key: "conditions.1",
  regionId: null,
  title: "Sales Price",
  body: "Prices are ex-works.",
  sortOrder: 4,
};

const rspAgreementBlock: ContentBlockRow = {
  key: "rsp.agreement",
  regionId: null,
  title: "RSP",
  body: "Remote support program.",
  sortOrder: 5,
};

/** An L-Series cutter: width only, no lay height, and a category nobody has
 * written quote copy for yet. */
const lSeriesItem = (overrides: Partial<QuotationItemInput> = {}) =>
  quotationItem({
    code: "L-320",
    name: "L-320 Cutting System",
    seriesName: "L-Series",
    specs: { cutWidthCm: 320, widthCode: 320 },
    seriesQuoteDescription: null,
    ...overrides,
  });

describe("buildQuotationData — machine specs", () => {
  it("reads cutHeightCm/cutWidthCm from the product's specs, never from its code", () => {
    // The code says "M3390"; the column says 99 x 99. The column wins — the
    // code is a label now (see src/lib/validation/product-specs.ts).
    const doc = quotationDoc({
      items: [
        quotationItem({
          code: "M3390",
          specs: { cutHeightCm: 99, cutWidthCm: 99 },
          seriesQuoteDescription: mSeriesCopy,
        }),
      ],
    });
    const data = buildQuotationData(doc, []);
    expect(data.machineSections[0].titleBlockHtml).toContain("Height 99cm, width 99cm");
  });

  it("line-strips the height/width line (never a blank) when the product records no specs", () => {
    const doc = quotationDoc({
      items: [
        quotationItem({
          code: "M999",
          specs: null,
          seriesQuoteDescription: "Model {{model}}.\n\nHeight {{cutHeightCm}}cm, width {{cutWidthCm}}cm.",
        }),
      ],
    });
    const data = buildQuotationData(doc, []);
    expect(data.machineSections[0].titleBlockHtml).toContain("Model M999");
    expect(data.machineSections[0].titleBlockHtml).not.toContain("Height");
    expect(data.machineSections[0].titleBlockHtml).not.toContain("____");
  });

  it("tolerates specs that fail validation (treated as none)", () => {
    const doc = quotationDoc({
      items: [
        quotationItem({
          code: "M450",
          specs: { cutHeightCm: "three", bogus: 1 },
          seriesQuoteDescription: "Model {{model}}.\n\nHeight {{cutHeightCm}}cm.",
        }),
      ],
    });
    const data = buildQuotationData(doc, []);
    // Unparseable specs are the same as none: the figure's line goes, the
    // rest of the copy stays, and nothing renders a bad value.
    expect(data.machineSections[0].titleBlockHtml).toContain("Model M450");
    expect(data.machineSections[0].titleBlockHtml).not.toContain("Height");
    expect(data.machineSections[0].specSentence).toBeNull();
  });

  it("exposes specSentence on the machine section from the specs and the series name", () => {
    const doc = quotationDoc({ items: [quotationItem({ code: "M3390", specs: { cutHeightCm: 3, cutWidthCm: 390 } })] });
    const data = buildQuotationData(doc, []);
    expect(data.machineSections[0].specSentence).toBe(
      "M-Series Cutting Machine, 3cm compressed lay height, 390cm cutting width"
    );
  });

  it("opens the sentence with the series' own name (X-Calibre), not a code", () => {
    const doc = quotationDoc({
      items: [quotationItem({ code: "X-3180", seriesName: "X-Calibre", specs: { cutHeightCm: 3, cutWidthCm: 180 } })],
    });
    const data = buildQuotationData(doc, []);
    expect(data.machineSections[0].specSentence).toBe(
      "X-Calibre Cutting Machine, 3cm compressed lay height, 180cm cutting width"
    );
  });

  it("exposes specSentence for an L-Series machine even when its category has no copy", () => {
    const doc = quotationDoc({ items: [lSeriesItem()] });
    const data = buildQuotationData(doc, []);
    expect(data.machineSections[0].specSentence).toBe("L-Series Cutting Machine with 320cm cutting width");
    // Nobody has written L-Series copy yet — verify the empty-copy case
    // still surfaces a real spec sentence rather than being left null/blank.
    expect(data.machineSections[0].titleBlockHtml).toBeNull();
  });

  it("leaves specSentence null for anything that is not a cutting machine (software)", () => {
    const doc = quotationDoc({
      items: [
        quotationItem({
          code: "PTW(S)",
          name: "PathWorks",
          kind: "SOFTWARE",
          seriesName: "Software",
          specs: { softwareMode: "standalone" },
          seriesQuoteDescription: "<p>PathWorks marker making.</p>",
        }),
      ],
    });
    const data = buildQuotationData(doc, []);
    expect(data.machineSections[0].specSentence).toBeNull();
  });

  it("does not introduce a spreader as a cutting machine even though it carries a cutWidthCm", () => {
    const doc = quotationDoc({
      items: [
        quotationItem({
          code: "FP-180",
          name: "Fabric Pro 180",
          kind: "SPREADER",
          seriesName: "Fabric Pro",
          specs: { cutWidthCm: 180, widthCode: 180 },
          seriesQuoteDescription: "<p>Spreads at {{cutWidthCm}}cm.</p>",
        }),
      ],
    });
    const data = buildQuotationData(doc, []);
    expect(data.machineSections[0].specSentence).toBeNull();
  });

  it("leaves specSentence null for a machine whose product no longer resolves a series", () => {
    const doc = quotationDoc({ items: [quotationItem({ seriesName: null })] });
    const data = buildQuotationData(doc, []);
    expect(data.machineSections[0].specSentence).toBeNull();
  });

  it("substitutes {{tableWidthMm}} / {{paperWidthMm}} from the specs for tables and Punchlines", () => {
    const doc = quotationDoc({
      items: [
        quotationItem({
          code: "EL-2020",
          name: "EasyLoader 2020",
          kind: "TABLE",
          seriesName: "EasyLoader",
          specs: { tableWidthMm: 2020 },
          seriesQuoteDescription: "Table width {{tableWidthMm}}mm.",
        }),
      ],
    });
    const data = buildQuotationData(doc, []);
    expect(data.machineSections[0].titleBlockHtml).toContain("Table width 2020mm");
  });
});

// --- the category's own copy, printed under the item heading ---------------
//
// `Series.quoteDescription` replaces the old `Product.contentBlockKey` ->
// ContentBlock lookup: one text authored per category, carried onto the item
// by `getDocumentForBuilder`, substituted with this product's own figures.
describe("category quote copy", () => {
  it("renders the category's copy under the item heading", () => {
    const doc = quotationDoc({
      items: [
        quotationItem({
          name: "M-5180 Cutting Machine",
          seriesQuoteDescription: "Cuts {{cutHeightCm}}cm at {{cutWidthCm}}cm wide.",
          specs: { cutHeightCm: 5, cutWidthCm: 180 },
        }),
      ],
    });
    const data = buildQuotationData(doc, []);
    expect(data.machineSections[0].titleBlockHtml).toContain("Cuts 5cm at 180cm wide.");
  });

  it("renders nothing when the category has no copy", () => {
    const doc = quotationDoc({ items: [quotationItem({ seriesQuoteDescription: null })] });
    const data = buildQuotationData(doc, []);
    expect(data.machineSections[0].titleBlockHtml).toBeNull();
  });

  it("always titles the section with the item's own name", () => {
    // The old rule trusted a content block's dynamic title; there is no title
    // field on a category any more, so this is now unconditional.
    const doc = quotationDoc({
      items: [quotationItem({ name: "L-220 Cutting Machine", seriesQuoteDescription: "<p>Copy.</p>" })],
    });
    const data = buildQuotationData(doc, []);
    expect(data.machineSections[0].sectionTitle).toBe("L-220 Cutting Machine");
  });

  it("strips a line whose figure this product lacks and reports the token", () => {
    // An L-Series machine carries cutWidthCm but no cutHeightCm.
    const doc = quotationDoc({
      items: [
        quotationItem({
          seriesQuoteDescription: "Width {{cutWidthCm}}cm\nHeight {{cutHeightCm}}cm",
          specs: { cutWidthCm: 220 },
        }),
      ],
    });
    const data = buildQuotationData(doc, []);
    expect(data.machineSections[0].titleBlockHtml).toContain("Width 220cm");
    expect(data.machineSections[0].titleBlockHtml).not.toContain("Height");
    // Attributed, not just named — the banner has to say which item and which
    // category, and link the category's editor by id.
    expect(data.strippedTokens).toEqual([
      { token: "cutHeightCm", itemName: "M5180 Cutting System", seriesName: "M-Series", seriesId: "series-m" },
    ]);
  });

  it("keeps the blocks of rich-text copy that do resolve", () => {
    // The defect this guards: Tiptap saves a whole document as one line, so
    // the `\n`-based strip used to delete the entire description over a
    // single missing figure.
    const doc = quotationDoc({
      items: [
        quotationItem({
          seriesQuoteDescription: "<p>Width {{cutWidthCm}}cm.</p><p>Height {{cutHeightCm}}cm.</p>",
          specs: { cutWidthCm: 220 },
        }),
      ],
    });
    const data = buildQuotationData(doc, []);
    expect(data.machineSections[0].titleBlockHtml).toContain("Width 220cm.");
    expect(data.machineSections[0].titleBlockHtml).not.toContain("Height");
    expect(data.strippedTokens).toEqual([
      { token: "cutHeightCm", itemName: "M5180 Cutting System", seriesName: "M-Series", seriesId: "series-m" },
    ]);
  });

  it("attributes a stripped token to each item's own category", () => {
    // The defect the attribution exists for: a quote holding a machine and an
    // EasyLoader, both losing a line, used to report one bare token list and
    // leave the reader guessing which of the two categories to open. Two
    // items, two categories, two entries — and the ids the banner links.
    const doc = quotationDoc({
      items: [
        quotationItem({
          name: "L-220 Cutting Machine",
          seriesName: "L-Series",
          seriesId: "series-l",
          specs: { cutWidthCm: 220 },
          seriesQuoteDescription: "<p>Height {{cutHeightCm}}cm.</p>",
        }),
        quotationItem({
          name: "EL-2020 EasyLoader",
          kind: "ACCESSORY",
          seriesName: "EasyLoader",
          seriesId: "series-el",
          specs: { tableWidthMm: 2000 },
          seriesQuoteDescription: "<p>Paper {{paperWidthMm}}mm.</p>",
        }),
      ],
    });
    const data = buildQuotationData(doc, []);
    expect(data.strippedTokens).toEqual([
      { token: "cutHeightCm", itemName: "L-220 Cutting Machine", seriesName: "L-Series", seriesId: "series-l" },
      { token: "paperWidthMm", itemName: "EL-2020 EasyLoader", seriesName: "EasyLoader", seriesId: "series-el" },
    ]);
  });

  it("reports the same token twice when two categories both lose it", () => {
    // A token-keyed accumulator collapsed these into one entry, which named
    // whichever category happened to be first and silently dropped the other.
    const doc = quotationDoc({
      items: [
        quotationItem({
          name: "L-220 Cutting Machine",
          seriesName: "L-Series",
          seriesId: "series-l",
          specs: { cutWidthCm: 220 },
          seriesQuoteDescription: "<p>Height {{cutHeightCm}}cm.</p>",
        }),
        quotationItem({
          name: "SP-180 Spreader",
          kind: "ACCESSORY",
          seriesName: "Spreaders",
          seriesId: "series-sp",
          specs: { cutWidthCm: 180 },
          seriesQuoteDescription: "<p>Height {{cutHeightCm}}cm.</p>",
        }),
      ],
    });
    const data = buildQuotationData(doc, []);
    expect(data.strippedTokens).toEqual([
      { token: "cutHeightCm", itemName: "L-220 Cutting Machine", seriesName: "L-Series", seriesId: "series-l" },
      { token: "cutHeightCm", itemName: "SP-180 Spreader", seriesName: "Spreaders", seriesId: "series-sp" },
    ]);
  });

  it("reports a token once per item however many of its lines it cost", () => {
    // Within one item the token is one thing to fix, so the banner must not
    // list it twice — the de-duplication the token-keyed accumulator did get
    // right, kept.
    const doc = quotationDoc({
      items: [
        quotationItem({
          seriesQuoteDescription: "<p>Height {{cutHeightCm}}cm.</p><p>Still {{cutHeightCm}}cm.</p>",
          specs: { cutWidthCm: 220 },
        }),
      ],
    });
    const data = buildQuotationData(doc, []);
    expect(data.strippedTokens).toEqual([
      { token: "cutHeightCm", itemName: "M5180 Cutting System", seriesName: "M-Series", seriesId: "series-m" },
    ]);
  });

  it("still reports a token for an item whose product no longer resolves a category", () => {
    // `seriesId`/`seriesName` are both null in that defensive case. The
    // banner still has to name the item; it just cannot offer a link.
    const doc = quotationDoc({
      items: [
        quotationItem({
          name: "Retired Machine",
          seriesName: null,
          seriesId: null,
          specs: {},
          seriesQuoteDescription: "<p>Height {{cutHeightCm}}cm.</p>",
        }),
      ],
    });
    const data = buildQuotationData(doc, []);
    expect(data.strippedTokens).toEqual([
      { token: "cutHeightCm", itemName: "Retired Machine", seriesName: null, seriesId: null },
    ]);
  });

  it("renders no copy at all when every block of it strips", () => {
    const doc = quotationDoc({
      items: [
        quotationItem({
          seriesQuoteDescription: "<p>Height {{cutHeightCm}}cm.</p><p>Paper {{paperWidthMm}}mm.</p>",
          specs: { cutWidthCm: 220 },
        }),
      ],
    });
    const data = buildQuotationData(doc, []);
    expect(data.machineSections[0].titleBlockHtml).toBeNull();
  });

  it("resolves {{name}} to the item's own name", () => {
    // The palette offers `{{name}}`, so buildQuotationData must fill it —
    // otherwise picking it from the editor silently deletes its own line.
    const doc = quotationDoc({
      items: [
        quotationItem({
          name: "M-5180 Cutting Machine",
          seriesQuoteDescription: "The {{name}} is built for volume.",
        }),
      ],
    });
    const data = buildQuotationData(doc, []);
    expect(data.machineSections[0].titleBlockHtml).toContain("The M-5180 Cutting Machine is built for volume.");
    expect(data.strippedTokens).toEqual([]);
  });

  it("still detects an inline price token in the category copy", () => {
    const doc = quotationDoc({
      items: [quotationItem({ seriesQuoteDescription: "Price: {{price}}" })],
      showItemPrices: true,
    });
    const data = buildQuotationData(doc, []);
    expect(data.machineSections[0].hasInlinePrice).toBe(true);
  });

  it("detects an inline price token written with inner spaces", () => {
    // `PLACEHOLDER_PATTERN` and `tokensIn` both accept `{{ price }}`, and so
    // does the save validator — so it substitutes fine. A raw
    // `.includes("{{price}}")` missed it, and the sheet then printed the
    // structural sectionPrice as well: the price twice.
    const doc = quotationDoc({
      items: [quotationItem({ seriesQuoteDescription: "Price: {{ price }}" })],
      showItemPrices: true,
    });
    const data = buildQuotationData(doc, []);
    expect(data.machineSections[0].hasInlinePrice).toBe(true);
  });

  it("fills every token the registry offers", () => {
    // The belt to the type-level braces (`vars` is a
    // `Record<CategoryTokenName, ...>` in buildQuotationData): a token added
    // to CATEGORY_TOKENS but not to the renderer would be offered by the
    // editor palette, accepted by the save validator, and then silently
    // delete its own line on every quote — which is exactly how `{{name}}`
    // shipped broken. This item is a MACHINE carrying every spec, so every
    // token in the registry is in scope for it and none has an excuse to
    // strip. It also carries a table module line, since `{{tableLengthM}}`
    // is filled from the item's own option lines rather than from its specs.
    const doc = quotationDoc({
      showItemPrices: true,
      items: [
        quotationItem({
          kind: "MACHINE",
          seriesName: "M-Series",
          specs: { cutHeightCm: 18, cutWidthCm: 180, tableWidthMm: 2200, paperWidthMm: 1600 },
          seriesQuoteDescription: CATEGORY_TOKENS.map((t) => `<p>${t.token}={{${t.token}}}</p>`).join(""),
          lines: [
            {
              id: "line-1",
              kind: "OPTION",
              code: null,
              name: "Drive Module",
              description: null,
              qty: 1,
              unitPrice: "4050.00",
              attributes: null,
              imageUrl: null,
              role: "EL_DRIVE",
              unitLengthM: 1.2,
            },
          ],
        }),
      ],
    });
    const data = buildQuotationData(doc, []);
    expect(data.strippedTokens).toEqual([]);
    for (const { token } of CATEGORY_TOKENS) {
      expect(data.machineSections[0].titleBlockHtml).toContain(`${token}=`);
    }
  });

  it("falls back to the structural price when the price line strips", () => {
    // The price line carries a second token this product has no figure for,
    // so the whole line goes. Reading the RAW copy left hasInlinePrice true
    // and the section showed no price at all.
    const doc = quotationDoc({
      items: [
        quotationItem({
          seriesQuoteDescription: "Price: {{price}} ({{cutHeightCm}} high)",
          specs: { cutWidthCm: 220 },
        }),
      ],
      showItemPrices: true,
    });
    const data = buildQuotationData(doc, []);
    expect(data.machineSections[0].titleBlockHtml).toBeNull();
    expect(data.machineSections[0].hasInlinePrice).toBe(false);
    expect(data.machineSections[0].sectionPrice).not.toBeNull();
  });
});

// --- {{tableLengthM}} -------------------------------------------------------
//
// The one COMPUTED token: not read off `Product.specs` like every other
// figure, but summed from the item's own EasyLoader module option lines. An
// EasyLoader is built from 1.2m modules (SECTION_UNIT_M), each sold as an
// option carrying `Option.unitLengthM`, so the table's length is a property
// of how this item was configured rather than of the product it came from.
describe("{{tableLengthM}}", () => {
  /** One EasyLoader module option line. `unitLengthM` is 1.2 unless a test
   * says otherwise, because that is what every module in the catalog is. */
  const moduleLine = (
    id: string,
    role: OptionRole,
    qty: number,
    unitLengthM: number | null = 1.2
  ): QuotationItemInput["lines"][number] => ({
    id,
    kind: "OPTION",
    code: null,
    name: `${role} module`,
    description: null,
    qty,
    unitPrice: "1000.00",
    attributes: null,
    imageUrl: null,
    role,
    unitLengthM,
  });

  /** An EasyLoader item whose category copy prints nothing but the length. */
  const easyLoader = (lines: QuotationItemInput["lines"]) =>
    quotationItem({
      code: "EL-2020",
      name: "EasyLoader 2020",
      kind: "TABLE",
      seriesName: "EasyLoader",
      seriesId: "series-el",
      specs: { tableWidthMm: 2020 },
      seriesQuoteDescription: "<p>Conveyorised Spreading Table ({{tableLengthM}})</p>",
      lines,
    });

  it("sums drive, conveyor and static modules into one length", () => {
    // 1 drive + 3 conveyor + 2 static = 6 modules x 1.2m = 7.2m. Note the
    // naive 1.2 * 6 in binary floating point is 7.199999999999999 — the
    // formatter is what makes this read as a measurement.
    const doc = quotationDoc({
      items: [
        easyLoader([
          moduleLine("l-drive", "EL_DRIVE", 1),
          moduleLine("l-conv", "EL_CONVEYOR", 3),
          moduleLine("l-static", "EL_STATIC", 2),
        ]),
      ],
    });
    const data = buildQuotationData(doc, []);
    expect(data.machineSections[0].titleBlockHtml).toContain("Conveyorised Spreading Table (7.2 m)");
    expect(data.strippedTokens).toEqual([]);
  });

  it("ignores busbar and rail, which run the table's whole length rather than adding to it", () => {
    // One busbar and one rail per module, for every module — so counting them
    // would report a 7.2m table as roughly 21.6m.
    const modules = [
      moduleLine("l-drive", "EL_DRIVE", 1),
      moduleLine("l-conv", "EL_CONVEYOR", 3),
      moduleLine("l-static", "EL_STATIC", 2),
    ];
    const withoutRunners = buildQuotationData(quotationDoc({ items: [easyLoader(modules)] }), []);
    const withRunners = buildQuotationData(
      quotationDoc({
        items: [
          easyLoader([...modules, moduleLine("l-bus", "EL_BUSBAR", 6), moduleLine("l-rail", "EL_RAIL", 6)]),
        ],
      }),
      []
    );
    expect(withRunners.machineSections[0].titleBlockHtml).toBe(
      withoutRunners.machineSections[0].titleBlockHtml
    );
    expect(withRunners.machineSections[0].titleBlockHtml).toContain("(7.2 m)");
  });

  it("drops the trailing zero on a whole number of metres", () => {
    const doc = quotationDoc({ items: [easyLoader([moduleLine("l-static", "EL_STATIC", 5)])] });
    // 5 x 1.2 = 6, printed "6 m" — "6.0 m" reads like a measurement someone
    // took rather than a count of sections.
    expect(buildQuotationData(doc, []).machineSections[0].titleBlockHtml).toContain("(6 m)");
  });

  it("ignores a non-module option line, however long it is", () => {
    // The MTS carries a `unitLengthM` too (additional travel), and is not
    // table the customer stands at.
    const doc = quotationDoc({
      items: [easyLoader([moduleLine("l-drive", "EL_DRIVE", 1), moduleLine("l-mts", "MTS_TRAVEL", 10)])],
    });
    expect(buildQuotationData(doc, []).machineSections[0].titleBlockHtml).toContain("(1.2 m)");
  });

  it("strips the line and reports the token for an item with no table modules", () => {
    // A category offering the token has products that CAN carry a layout;
    // this individual item has none configured, so there is no length to
    // print. Correct behaviour, and the draft banner says so.
    const doc = quotationDoc({ items: [easyLoader([])] });
    const data = buildQuotationData(doc, []);
    expect(data.machineSections[0].titleBlockHtml).toBeNull();
    expect(data.strippedTokens).toEqual([
      { token: "tableLengthM", itemName: "EasyLoader 2020", seriesName: "EasyLoader", seriesId: "series-el" },
    ]);
  });

  it("reports the token when the only module lines carry no unit length", () => {
    // A module option whose `unitLengthM` was never set contributes nothing,
    // and an item whose every module is like that has no length at all —
    // reported rather than printed as "0 m".
    const doc = quotationDoc({
      items: [easyLoader([moduleLine("l-drive", "EL_DRIVE", 1, null)])],
    });
    const data = buildQuotationData(doc, []);
    expect(data.machineSections[0].titleBlockHtml).toBeNull();
    expect(data.strippedTokens.map((s) => s.token)).toEqual(["tableLengthM"]);
  });
});

describe("option rows", () => {
  it("describes an option from its own snapshot description", () => {
    const doc = quotationDoc({
      items: [
        quotationItem({
          lines: [
            {
              id: "l-1",
              kind: "OPTION",
              role: null,
              unitLengthM: null,
              code: "MTS",
              name: "Motorised Table System",
              description: "Adds a motorised transfer table.",
              qty: 1,
              unitPrice: "5000.00",
              attributes: { metres: 4 },
              imageUrl: null,
            },
          ],
        }),
      ],
    });
    const data = buildQuotationData(doc, []);
    const row = data.machineSections[0].optionRows[0];
    expect(row.descriptionHtml).toContain("Adds a motorised transfer table.");
    expect(row.attributesLine).toBe("metres: 4");
  });
});

describe("buildQuotationData", () => {
  it("renders the category's copy with substituted vars", () => {
    // `model` is substituted with the raw `item.code` (e.g. "M5180") as-is —
    // the M-Series copy uses a bare "{{model}}" (no hardcoded "M" prefix),
    // so a full product code renders correctly with no doubled "M".
    const data = buildQuotationData(
      quotationDoc({ items: [quotationItem({ code: "M450", seriesQuoteDescription: mSeriesCopy })] }),
      []
    );
    expect(data.machineSections).toHaveLength(1);
    expect(data.machineSections[0].titleBlockHtml).toContain("Model M450");
    expect(data.machineSections[0].titleBlockHtml).toContain("Height 18cm, width 180cm");
  });

  it("leaves titleBlockHtml null for a product whose category has no copy", () => {
    const doc = quotationDoc({
      items: [quotationItem({ code: "EF-100", kind: "FEEDER", seriesQuoteDescription: null })],
    });
    const data = buildQuotationData(doc, []);
    expect(data.machineSections[0].titleBlockHtml).toBeNull();
  });

  it("leaves titleBlockHtml null when the category's copy is empty rather than absent", () => {
    // An editor that saves an empty body stores "" (or null — see
    // seriesQuoteDescriptionSchema); both mean "print nothing", and neither
    // may render an empty <p> under the heading.
    const doc = quotationDoc({ items: [quotationItem({ seriesQuoteDescription: "" })] });
    const data = buildQuotationData(doc, []);
    expect(data.machineSections[0].titleBlockHtml).toBeNull();
  });

  it("gives each item the copy of its own category, never a neighbour's", () => {
    // Copy travels on the item (from its product's series), so two items on
    // one quote never share or swap it — what the old per-product block key
    // guaranteed by being read per product rather than per code or series.
    const doc = quotationDoc({
      items: [
        quotationItem({ id: "i-m", code: "M5180", seriesQuoteDescription: "Cuts at {{cutWidthCm}}cm." }),
        quotationItem({
          id: "i-pl",
          code: "PL-1880",
          name: "Punchline 1880",
          kind: "ACCESSORY",
          specs: { paperWidthMm: 1880 },
          seriesQuoteDescription: "Paper width {{paperWidthMm}}mm.",
        }),
      ],
    });
    const data = buildQuotationData(doc, []);
    expect(data.machineSections[0].titleBlockHtml).toContain("Cuts at 180cm");
    expect(data.machineSections[1].titleBlockHtml).toContain("Paper width 1880mm");
    expect(data.machineSections[1].titleBlockHtml).not.toContain("Cuts at");
  });

  it("strips the entire Price line (never a blank) when both price-display toggles are off", () => {
    // code "M450" deliberately doesn't match the M/X code pattern (see
    // machine-specs.ts) so height/width fall back to the item's stored
    // `specs` (18/180) — same fixture shape as the "resolves a machine title
    // block" test above — keeping this test's height/width assertion
    // independent of code-parsing behaviour.
    const doc = quotationDoc({
      showItemPrices: false,
      showOptionPrices: false,
      items: [quotationItem({ code: "M450", seriesQuoteDescription: mSeriesCopy })],
    });
    const data = buildQuotationData(doc, []);
    expect(data.machineSections[0].titleBlockHtml).not.toContain("Price");
    expect(data.machineSections[0].titleBlockHtml).not.toContain("____");
    // The rest of the copy (a separate line) still renders untouched.
    expect(data.machineSections[0].titleBlockHtml).toContain("Height 18cm, width 180cm");
    // A price hidden on purpose is not a missing figure — the draft banner
    // must not name it.
    expect(data.strippedTokens).toEqual([]);
  });

  it("substitutes the item's TOTAL (incl. options), currency-formatted, when showItemPrices is on", () => {
    const doc = quotationDoc({
      showItemPrices: true,
      showOptionPrices: false,
      items: [quotationItem({ unitPrice: "175000.00", total: "180000.00", seriesQuoteDescription: mSeriesCopy })],
    });
    const data = buildQuotationData(doc, []);
    // Uses the pricing engine's per-item TOTAL (180000, incl. an option),
    // not the bare unit price (175000) — and formatted via formatMoney, not
    // a raw decimal string.
    expect(data.machineSections[0].titleBlockHtml).toContain("Price: $180,000");
    expect(data.machineSections[0].titleBlockHtml).not.toContain("175000");
  });

  it("substitutes {{basePrice}} with the machine's own price, distinct from the combined {{price}} total", () => {
    const doc = quotationDoc({
      showItemPrices: true,
      showOptionPrices: false,
      items: [
        quotationItem({
          unitPrice: "175000.00",
          total: "180000.00",
          seriesQuoteDescription: "Base: {{basePrice}}\n\nTotal: {{price}}",
        }),
      ],
    });
    const data = buildQuotationData(doc, []);
    // {{basePrice}} resolves to the bare machine price (175000), while the
    // pre-existing {{price}} keeps meaning the combined subtotal (180000,
    // incl. the option) — so catalogue templates that already reference
    // {{price}} keep working unchanged.
    expect(data.machineSections[0].titleBlockHtml).toContain("Base: $175,000");
    expect(data.machineSections[0].titleBlockHtml).toContain("Total: $180,000");
  });

  it("strips the {{basePrice}} line (never a blank) when both price-display toggles are off", () => {
    const doc = quotationDoc({
      showItemPrices: false,
      showOptionPrices: false,
      items: [quotationItem({ code: "M450", seriesQuoteDescription: "Model {{model}}.\n\nBase: {{basePrice}}" })],
    });
    const data = buildQuotationData(doc, []);
    expect(data.machineSections[0].titleBlockHtml).not.toContain("Base");
    expect(data.machineSections[0].titleBlockHtml).not.toContain("____");
    expect(data.machineSections[0].titleBlockHtml).toContain("Model M450");
  });

  it("substitutes the real price when only showOptionPrices is on (implies item prices visible)", () => {
    const doc = quotationDoc({
      showItemPrices: false,
      showOptionPrices: true,
      items: [quotationItem({ seriesQuoteDescription: mSeriesCopy })],
    });
    const data = buildQuotationData(doc, []);
    expect(data.machineSections[0].titleBlockHtml).toContain("Price: $175,000");
  });

  it("passes both price-display toggles through onto the returned QuotationData", () => {
    const doc = quotationDoc({ showItemPrices: true, showOptionPrices: false });
    const data = buildQuotationData(doc, []);
    expect(data.showItemPrices).toBe(true);
    expect(data.showOptionPrices).toBe(false);
  });

  it("gives every OPTION line a row, described or not", () => {
    const doc = quotationDoc({
      items: [
        quotationItem({
          lines: [
            {
              id: "line-1",
              kind: "OPTION",
              role: null,
              unitLengthM: null,
              code: "MTS",
              name: "Machine Transfer System",
              description: "Travels the machine between tables.",
              qty: 1,
              unitPrice: "5000.00",
              attributes: { metres: 4, tables: 2 },
              imageUrl: null,
            },
            {
              id: "line-2",
              kind: "OPTION",
              role: null,
              unitLengthM: null,
              code: "ZZZ-NOPE",
              name: "Unknown option",
              description: null,
              qty: 1,
              unitPrice: "0.00",
              attributes: null,
              imageUrl: null,
            },
          ],
        }),
      ],
    });
    const data = buildQuotationData(doc, []);
    const rows = data.machineSections[0].optionRows;
    // Both lines land as rows in the ONE unified table, described the one
    // same way — from the description the line snapshotted off the option.
    expect(rows).toHaveLength(2);
    expect(rows[0].descriptionHtml).toContain("Travels the machine between tables");
    // An option that carries no description of its own is never silently
    // dropped — it still gets its own row in the same table (owner: "no
    // selected option may be silently omitted").
    expect(rows[1]).toMatchObject({
      code: "ZZZ-NOPE",
      name: "Unknown option",
      qty: 1,
    });
    expect(rows[1].descriptionHtml).toBeNull();
  });

  it("no selected option is ever omitted: 3 options (1 described, 2 not) all appear in the one unified table", () => {
    const doc = quotationDoc({
      showOptionPrices: true,
      items: [
        quotationItem({
          lines: [
            {
              id: "line-1",
              kind: "OPTION",
              role: null,
              unitLengthM: null,
              code: "MTS",
              name: "Machine Transfer System",
              description: "Travels the machine between tables.",
              qty: 1,
              unitPrice: "5000.00",
              attributes: { metres: 4, tables: 2 },
              imageUrl: null,
            },
            {
              id: "line-2",
              kind: "OPTION",
              role: null,
              unitLengthM: null,
              code: "UNDESCRIBED-1",
              name: "First undescribed option",
              description: null,
              qty: 2,
              unitPrice: "570.00",
              attributes: null,
              imageUrl: null,
            },
            {
              id: "line-3",
              kind: "OPTION",
              role: null,
              unitLengthM: null,
              code: null,
              name: "Second undescribed option",
              description: null,
              qty: 1,
              unitPrice: "100.00",
              attributes: { colour: "Blue" },
              imageUrl: null,
            },
          ],
        }),
      ],
    });
    const data = buildQuotationData(doc, []);
    const rows = data.machineSections[0].optionRows;

    // All 3 selected options are accounted for, in line order, in the one
    // unified table — none silently dropped just because it carries no
    // description of its own.
    expect(rows.map((r) => r.name)).toEqual([
      "Machine Transfer System",
      "First undescribed option",
      "Second undescribed option",
    ]);
    expect(rows).toHaveLength(3);

    // A described row renders its description as descriptionHtml, and —
    // unlike the old optionBlocksHtml, which never showed a price at all —
    // gets the same price column every row gets (gated by showOptionPrices,
    // same as before).
    expect(rows[0].descriptionHtml).toContain("Travels the machine between tables");
    expect(rows[0].price).toBe("$5,000");

    // qty >1 and price (gated by showOptionPrices) both surface on an
    // undescribed row.
    expect(rows[1].qty).toBe(2);
    expect(rows[1].price).toBe("$1,140");
    // Attribute values surface too, when present, as one flattened line.
    expect(rows[2].attributesLine).toBe("colour: Blue");
    expect(rows[2].code).toBeNull();
  });

  it("hides option row prices when showOptionPrices is off", () => {
    const doc = quotationDoc({
      showOptionPrices: false,
      items: [
        quotationItem({
          lines: [
            {
              id: "line-1",
              kind: "OPTION",
              role: null,
              unitLengthM: null,
              code: "UNDESCRIBED",
              name: "Undescribed option",
              description: null,
              qty: 1,
              unitPrice: "100.00",
              attributes: null,
              imageUrl: null,
            },
          ],
        }),
      ],
    });
    const data = buildQuotationData(doc, []);
    expect(data.machineSections[0].optionRows[0].price).toBeNull();
  });

  it("carries qty onto an option row (for the table's qty column)", () => {
    const doc = quotationDoc({
      items: [
        quotationItem({
          lines: [
            {
              id: "line-1",
              kind: "OPTION",
              role: null,
              unitLengthM: null,
              code: "MTS",
              name: "Machine Transfer System",
              description: "Travels the machine between tables.",
              qty: 3,
              unitPrice: "5000.00",
              attributes: { metres: 4, tables: 2 },
              imageUrl: null,
            },
          ],
        }),
      ],
    });
    const data = buildQuotationData(doc, []);
    expect(data.machineSections[0].optionRows[0].qty).toBe(3);
  });

  it("substitutes bankDetails into terms blocks and sorts terms/conditions by sortOrder", () => {
    const data = buildQuotationData(quotationDoc(), [termsBlock, conditionsBlock]);
    expect(data.termsSections).toHaveLength(1);
    // Multi-line: each bank field (bank/bsb/accountNo, per baseDoc's fixture)
    // renders as its own line, not squashed onto one.
    expect(data.termsSections[0].bodyHtml).toContain("Bank: ANZ Westfield");
    expect(data.termsSections[0].bodyHtml).toContain("BSB: 013 442");
    expect(data.termsSections[0].bodyHtml).toContain("Account No.: 4405 63886");
    expect(data.conditionsSections).toHaveLength(1);
    expect(data.conditionsSections[0].key).toBe("conditions.1");
  });

  it("auto-fills the standard-terms defaults (deliveryWeeks/installationDays/trainingDays/warrantyMonths)", () => {
    const deliveryBlock: ContentBlockRow = {
      key: "terms.delivery",
      regionId: null,
      title: "Delivery",
      body: "Included in sale price. (Estimated {{deliveryWeeks}} weeks.)",
      sortOrder: 6,
    };
    const scheduleBlock: ContentBlockRow = {
      key: "terms.schedule",
      regionId: null,
      title: "Schedule",
      body: "- Installation approx. {{installationDays}} days.\n- Operator training approx. {{trainingDays}} days.",
      sortOrder: 7,
    };
    const warrantyBlock: ContentBlockRow = {
      key: "terms.warranty",
      regionId: null,
      title: "Warranty",
      body: "{{warrantyMonths}}-month parts warranty.",
      sortOrder: 8,
    };
    const data = buildQuotationData(quotationDoc(), [deliveryBlock, scheduleBlock, warrantyBlock]);
    const bodies = data.termsSections.map((t) => t.bodyHtml).join("\n");
    // None of these are wired up from any per-document source today — every
    // one must come from the auto-fill default, with no "____"/stripped line.
    expect(bodies).toContain("Estimated 14 weeks");
    expect(bodies).toContain("Installation approx. 2 days");
    expect(bodies).toContain("Operator training approx. 3 days");
    expect(bodies).toContain("12-month parts warranty");
  });

  it("still line-strips a genuinely-unknown terms token (e.g. rspYear2Cost) with no default", () => {
    const rspTermsBlock: ContentBlockRow = {
      key: "terms.rsp",
      regionId: null,
      title: "RSP",
      body: "Customer agrees to 2nd year RSP.\n\n- 1st Year: 100% discount.\n- 2nd Year: {{rspYear2Cost}} + GST.",
      sortOrder: 9,
    };
    const data = buildQuotationData(quotationDoc(), [rspTermsBlock]);
    expect(data.termsSections[0].bodyHtml).toContain("1st Year: 100% discount");
    expect(data.termsSections[0].bodyHtml).not.toContain("2nd Year");
    expect(data.termsSections[0].bodyHtml).not.toContain("____");
  });

  it("builds an RSP coverage row per item with a 'TBA' unit cost (table cell, not a markdown line — never '____')", () => {
    const doc = quotationDoc({ items: [quotationItem({ name: "M5180 Cutting System", serialNumber: "SN-001" })] });
    const data = buildQuotationData(doc, [rspAgreementBlock]);
    expect(data.rsp.agreementHtml).toContain("Remote support program");
    expect(data.rsp.coverageRows).toEqual([{ name: "M5180 Cutting System", serialNumber: "SN-001", rspUnitCost: "TBA" }]);
  });

  it("blanks serialNumber when unset rather than rendering null", () => {
    const data = buildQuotationData(quotationDoc(), []);
    expect(data.rsp.coverageRows[0].serialNumber).toBe("");
  });

  it("includes every MACHINE and SYSTEM item (the M / X / L cutters and the LNS system)", () => {
    const doc = quotationDoc({
      items: [
        quotationItem({ id: "i-m", name: "M item", kind: "MACHINE", seriesName: "M-Series" }),
        quotationItem({ id: "i-xc", name: "X item", kind: "MACHINE", seriesName: "X-Calibre" }),
        quotationItem({ id: "i-l", name: "L item", kind: "MACHINE", seriesName: "L-Series" }),
        quotationItem({ id: "i-lns", name: "LNS item", kind: "SYSTEM", seriesName: "Leather Nesting System" }),
      ],
    });
    const data = buildQuotationData(doc, []);
    expect(data.rsp.coverageRows.map((r) => r.name)).toEqual(["M item", "X item", "L item", "LNS item"]);
  });

  it("excludes every other kind with no serial number (table, feeder, spreader, software, service, accessory)", () => {
    const doc = quotationDoc({
      items: [
        quotationItem({ id: "i-el", name: "Easy-Loader", kind: "TABLE", serialNumber: null }),
        quotationItem({ id: "i-ef", name: "Easy-Feeder", kind: "FEEDER", serialNumber: null }),
        quotationItem({ id: "i-fp", name: "Fabric Pro", kind: "SPREADER", serialNumber: null }),
        quotationItem({ id: "i-sw", name: "PathWorks", kind: "SOFTWARE", serialNumber: null }),
        quotationItem({ id: "i-svc", name: "Service", kind: "SERVICE", serialNumber: null }),
        quotationItem({ id: "i-acc", name: "Roll feeder", kind: "ACCESSORY", serialNumber: null }),
        quotationItem({ id: "i-cr", name: "Trade-in", kind: "CREDIT", serialNumber: null }),
      ],
    });
    const data = buildQuotationData(doc, []);
    expect(data.rsp.coverageRows).toEqual([]);
  });

  it("includes a non-machine item when it has a serial number", () => {
    const doc = quotationDoc({
      items: [quotationItem({ name: "Fabric Master", kind: "ACCESSORY", seriesName: null, serialNumber: "SN-FM-1" })],
    });
    const data = buildQuotationData(doc, []);
    expect(data.rsp.coverageRows).toEqual([{ name: "Fabric Master", serialNumber: "SN-FM-1", rspUnitCost: "TBA" }]);
  });
});

// --- buildQuotationData: sectionTitle — every section gets a heading -------
//
// Root cause of the owner-reported missing headings: `titleBlockHtml` used
// to be the ONLY thing quotation-sheet.tsx rendered for a matched block, and
// whether that carried a visible heading depended entirely on whether the
// block's own markdown BODY happened to start with a "##" line.
// machine.m-series's real seed body did (coincidentally, since it also
// repeated the model in its own template); equipment.easy-loader,
// equipment.fabric-pro, software.pathworks-s/-i and equipment.punchline
// never did, so those sections rendered with no heading at all — and a
// blockless item (e.g. L-Series) only got one via the separate auto-summary
// fallback path. `sectionTitle` replaces all of that with one computation
// that always runs, for every section, with copy or without.
describe("buildQuotationData — sectionTitle", () => {
  // The heading is the item's own name, unconditionally. Category copy has
  // no title field to compete with it — which is the point: a shared title
  // (the old content block's "Easy-Loader #1", or now one category's text
  // read by six products) could only ever name one of them, and named the
  // wrong one for the rest.
  it("uses the item's own name as the heading even when its category has copy", () => {
    const data = buildQuotationData(
      quotationDoc({ items: [quotationItem({ code: "M450", seriesQuoteDescription: mSeriesCopy })] }),
      []
    );
    expect(data.machineSections[0].sectionTitle).toBe("M5180 Cutting System");
  });

  it("heads two products of the same category each with its own name", () => {
    // The case a shared title cannot serve: one category's copy, two
    // products. Each heading names the product it sits above.
    const doc = quotationDoc({
      items: [
        quotationItem({ id: "i-1", code: "M5180", name: "M5180 Cutting System", seriesQuoteDescription: mSeriesCopy }),
        quotationItem({ id: "i-2", code: "M3390", name: "M3390 Cutting System", seriesQuoteDescription: mSeriesCopy }),
      ],
    });
    const data = buildQuotationData(doc, []);
    expect(data.machineSections.map((s) => s.sectionTitle)).toEqual(["M5180 Cutting System", "M3390 Cutting System"]);
  });

  it("uses the item's name when its category has no copy at all", () => {
    const doc = quotationDoc({
      items: [
        quotationItem({ code: "EF-100", name: "EF-100 Accessory", kind: "FEEDER", seriesQuoteDescription: null }),
      ],
    });
    const data = buildQuotationData(doc, []);
    expect(data.machineSections[0].sectionTitle).toBe("EF-100 Accessory");
  });

  it("uses the item's name for a product whose category nobody has written copy for (e.g. L-Series)", () => {
    const doc = quotationDoc({ items: [lSeriesItem()] });
    const data = buildQuotationData(doc, []);
    expect(data.machineSections[0].sectionTitle).toBe("L-320 Cutting System");
  });

  it("heads a section whose copy carries no heading of its own", () => {
    // Category copy is body prose, never a heading — the section must still
    // be titled, which is what the missing-heading bug was about.
    const doc = quotationDoc({
      items: [quotationItem({ name: "M5180 Cutting System", seriesQuoteDescription: "Model {{model}}." })],
    });
    const data = buildQuotationData(doc, []);
    expect(data.machineSections[0].sectionTitle).toBe("M5180 Cutting System");
  });

  it("still heads a section whose copy was stripped away entirely by an unresolved token", () => {
    const doc = quotationDoc({
      items: [quotationItem({ name: "M5180 Cutting System", seriesQuoteDescription: "{{rspUnitCost}}" })],
    });
    const data = buildQuotationData(doc, []);
    expect(data.machineSections[0].sectionTitle).toBe("M5180 Cutting System");
    expect(data.machineSections[0].titleBlockHtml).toBeNull();
    expect(data.strippedTokens).toEqual([
      { token: "rspUnitCost", itemName: "M5180 Cutting System", seriesName: "M-Series", seriesId: "series-m" },
    ]);
  });
});

// --- dedupeOptionCode — the unified options table's duplicate-label fix ----
//
// Owner-reported duplicates in the old rendering: "1.0mm dia punch — 1.0mm
// dia punch" (code === name) and "Drills included 2301071-7-10 —
// 2301071-7-10" (code embedded as a suffix of name) — both are option rows
// whose code carries no information the name doesn't already show.
describe("dedupeOptionCode", () => {
  it("returns null when code and name are identical", () => {
    expect(dedupeOptionCode("1.0mm dia punch", "1.0mm dia punch")).toBeNull();
  });

  it("returns null when name embeds code as a suffix (owner repro: drills)", () => {
    expect(dedupeOptionCode("2301071-7-10", "Drills included 2301071-7-10")).toBeNull();
  });

  it("returns null when code embeds name (the reverse containment)", () => {
    expect(dedupeOptionCode("ABR-M Full Name", "ABR-M")).toBeNull();
  });

  it("returns the code unchanged when it's genuinely distinct from the name", () => {
    expect(dedupeOptionCode("MTS", "Machine Transfer System")).toBe("MTS");
  });

  it("returns null for a null code", () => {
    expect(dedupeOptionCode(null, "Some option")).toBeNull();
  });
});

// --- buildQuotationData: unified options table ------------------------------

describe("buildQuotationData — unified options table (QuotationOptionRow)", () => {
  it("resolves an option's imageUrl through the same resolver as item images (icon flow: query -> data -> sheet)", () => {
    const doc = quotationDoc({
      items: [
        quotationItem({
          lines: [
            {
              id: "line-1",
              kind: "OPTION",
              role: null,
              unitLengthM: null,
              code: "MTS",
              name: "Machine Transfer System",
              description: null,
              qty: 1,
              unitPrice: "5000.00",
              attributes: null,
              imageUrl: "/api/files/mts-icon.png",
            },
          ],
        }),
      ],
    });
    const data = buildQuotationData(doc, [], {
      resolveImage: (url) => `resolved:${url}`,
    });
    expect(data.machineSections[0].optionRows[0].icon).toBe("resolved:/api/files/mts-icon.png");
  });

  it("leaves icon null when the line carries no imageUrl", () => {
    const doc = quotationDoc({
      items: [
        quotationItem({
          lines: [
            {
              id: "line-1",
              kind: "OPTION",
              role: null,
              unitLengthM: null,
              code: "MTS",
              name: "Machine Transfer System",
              description: null,
              qty: 1,
              unitPrice: "5000.00",
              attributes: null,
              imageUrl: null,
            },
          ],
        }),
      ],
    });
    const data = buildQuotationData(doc, []);
    expect(data.machineSections[0].optionRows[0].icon).toBeNull();
  });

  it("describes each row from its own line, never from another row's", () => {
    // The old rule this replaces: a row's description came from the block
    // its option's `contentBlockKey` named — deliberately not from its code,
    // so two options with similar codes could not steal each other's prose.
    // The description is snapshotted on the line itself now, which makes the
    // same guarantee structurally.
    const doc = quotationDoc({
      items: [
        quotationItem({
          lines: [
            {
              id: "line-1",
              kind: "OPTION",
              role: null,
              unitLengthM: null,
              code: "ABR-M",
              name: "Automatic Blade Replacement",
              description: "Automatic blade replacement.",
              qty: 1,
              unitPrice: "1000.00",
              attributes: null,
              imageUrl: null,
            },
            {
              id: "line-2",
              kind: "OPTION",
              role: null,
              unitLengthM: null,
              code: "MTS",
              name: "Machine Transfer System",
              description: "Travels the machine between tables.",
              qty: 1,
              unitPrice: "5000.00",
              attributes: null,
              imageUrl: null,
            },
          ],
        }),
      ],
    });
    const data = buildQuotationData(doc, []);
    const rows = data.machineSections[0].optionRows;
    expect(rows[0].descriptionHtml).toContain("Automatic blade replacement");
    expect(rows[0].descriptionHtml).not.toContain("Travels");
    expect(rows[1].descriptionHtml).toContain("Travels the machine between tables");
    expect(rows[1].descriptionHtml).not.toContain("blade");
  });

  it("dedupes the row's own code when it's redundant with its name", () => {
    const doc = quotationDoc({
      items: [
        quotationItem({
          lines: [
            {
              id: "line-1",
              kind: "OPTION",
              role: null,
              unitLengthM: null,
              code: "ZZZ-NOPE",
              name: "ZZZ-NOPE",
              description: null,
              qty: 1,
              unitPrice: "0.00",
              attributes: null,
              imageUrl: null,
            },
          ],
        }),
      ],
    });
    const data = buildQuotationData(doc, []);
    expect(data.machineSections[0].optionRows[0]).toMatchObject({ code: null, name: "ZZZ-NOPE" });
  });

  it("renders the line's own (deduped) description", () => {
    const doc = quotationDoc({
      items: [
        quotationItem({
          lines: [
            {
              id: "line-1",
              kind: "OPTION",
              role: null,
              unitLengthM: null,
              code: "UNMATCHED",
              name: "Unmatched option",
              description: "A short freeform description",
              qty: 1,
              unitPrice: "0.00",
              attributes: null,
              imageUrl: null,
            },
          ],
        }),
      ],
    });
    const data = buildQuotationData(doc, []);
    expect(data.machineSections[0].optionRows[0].descriptionHtml).toContain("A short freeform description");
  });

  it("descriptionHtml is null when the line's description is redundant with its name", () => {
    const doc = quotationDoc({
      items: [
        quotationItem({
          lines: [
            {
              id: "line-1",
              kind: "OPTION",
              role: null,
              unitLengthM: null,
              code: "UNMATCHED",
              name: "Unmatched option",
              description: "Unmatched option", // identical to name -> deduped away
              qty: 1,
              unitPrice: "0.00",
              attributes: null,
              imageUrl: null,
            },
          ],
        }),
      ],
    });
    const data = buildQuotationData(doc, []);
    expect(data.machineSections[0].optionRows[0].descriptionHtml).toBeNull();
  });

  it("flattens attributes to one 'key: value · key: value' line, null when there are none", () => {
    const doc = quotationDoc({
      items: [
        quotationItem({
          lines: [
            {
              id: "line-1",
              kind: "OPTION",
              role: null,
              unitLengthM: null,
              code: "MTS",
              name: "Machine Transfer System",
              description: null,
              qty: 1,
              unitPrice: "5000.00",
              attributes: { metres: 4, tables: 2 },
              imageUrl: null,
            },
            {
              id: "line-2",
              kind: "OPTION",
              role: null,
              unitLengthM: null,
              code: "UNMATCHED",
              name: "Unmatched option",
              description: null,
              qty: 1,
              unitPrice: "0.00",
              attributes: null,
              imageUrl: null,
            },
          ],
        }),
      ],
    });
    const data = buildQuotationData(doc, []);
    const rows = data.machineSections[0].optionRows;
    expect(rows[0].attributesLine).toBe("metres: 4 · tables: 2");
    expect(rows[1].attributesLine).toBeNull();
  });

  it("gates every row's price on showOptionPrices", () => {
    const line: QuotationItemInput["lines"][number] = {
      id: "line-1",
      kind: "OPTION",
      role: null,
      unitLengthM: null,
      code: "MTS",
      name: "Machine Transfer System",
      description: null,
      qty: 2,
      unitPrice: "500.00",
      attributes: null,
      imageUrl: null,
    };

    const off = buildQuotationData(
      quotationDoc({ showOptionPrices: false, items: [quotationItem({ lines: [line] })] }),
      []
    );
    expect(off.machineSections[0].optionRows[0].price).toBeNull();

    const on = buildQuotationData(
      quotationDoc({ showOptionPrices: true, items: [quotationItem({ lines: [line] })] }),
      []
    );
    expect(on.machineSections[0].optionRows[0].price).toBe("$1,000");
  });
});

// --- buildQuotationData: structural section price (owner: every item
// section must show its price) ---------------------------------------------
//
// Root cause of the owner-reported missing prices: EL-2020/PTW(I)/FP-180's
// copy never carried a "Price: {{price}}" line the way the M-Series' did, so
// those sections showed no price at all. `sectionPrice`/`hasInlinePrice`
// make the price structural for every section, while still avoiding a double
// print for a category whose copy already inlines its own price line.
// The Equipment Detail table repeats the machine and its price, so it has to
// follow the same rules the Investment Summary's own base row does — the two
// disagreeing is what put "$0" next to EL-2020 on one page and nothing on the
// next. See `ItemBreakdown.basePriceUnquoted` / `assembledFromOptions`.
describe("buildQuotationData — baseRow for a product with no price of its own", () => {
  const driveModule = {
    id: "line-1",
    kind: "OPTION" as const,
    role: null,
    unitLengthM: null,
    code: "EL-2020 Drive Module (first 1.2M)",
    name: "Drive Module",
    description: null,
    qty: 1,
    unitPrice: "4050.00",
    attributes: null,
    imageUrl: null,
  };

  const sectionFor = (item: Partial<Parameters<typeof quotationItem>[0]>) =>
    buildQuotationData(quotationDoc({ showOptionPrices: true, items: [quotationItem(item)] }), []).machineSections[0];

  it("drops the row for an EasyLoader, whose modules carry the whole price", () => {
    const section = sectionFor({
      code: "EL-2020",
      name: "EasyLoader 2020",
      unitPrice: "0.00",
      listPrice: "0.00",
      total: "4050.00",
      lines: [driveModule],
    });
    expect(section.baseRow).toBeNull();
    // Never leaves an empty table — the modules are still there to head it.
    expect(section.optionRows.length).toBeGreaterThan(0);
  });

  it("keeps an unpriced row for Service, which has no options to carry it", () => {
    const section = sectionFor({
      code: "SERVICE",
      name: "Service",
      unitPrice: "0.00",
      listPrice: "0.00",
      total: "0.00",
      lines: [],
    });
    expect(section.baseRow).not.toBeNull();
    expect(section.baseRow?.price).toBeNull();
  });

  it("keeps the row and its $0 for a machine hand-zeroed as a giveaway", () => {
    const section = sectionFor({ unitPrice: "0.00", total: "0.00", lines: [driveModule] });
    expect(section.baseRow?.price).toBe("$0");
  });

  it("prints the price of an ordinary machine unchanged", () => {
    const section = sectionFor({ lines: [driveModule] });
    expect(section.baseRow?.price).toBe("$175,000");
  });
});

describe("buildQuotationData — sectionPrice / hasInlinePrice", () => {
  it("exposes sectionPrice (item total incl. options) when a price toggle is on", () => {
    const doc = quotationDoc({ showItemPrices: true, items: [quotationItem({ total: "180000.00" })] });
    const data = buildQuotationData(doc, []);
    expect(data.machineSections[0].sectionPrice).toBe("$180,000");
  });

  it("is null when both price-display toggles are off", () => {
    const doc = quotationDoc({ showItemPrices: false, showOptionPrices: false });
    const data = buildQuotationData(doc, []);
    expect(data.machineSections[0].sectionPrice).toBeNull();
  });

  it("is visible when only showOptionPrices is on (implies item totals visible)", () => {
    const doc = quotationDoc({ showItemPrices: false, showOptionPrices: true, items: [quotationItem({ total: "175000.00" })] });
    const data = buildQuotationData(doc, []);
    expect(data.machineSections[0].sectionPrice).toBe("$175,000");
  });

  it("hasInlinePrice is true for category copy whose raw body references {{price}} (the M-Series copy)", () => {
    const doc = quotationDoc({ items: [quotationItem({ code: "M450", seriesQuoteDescription: mSeriesCopy })] });
    const data = buildQuotationData(doc, []);
    expect(data.machineSections[0].hasInlinePrice).toBe(true);
  });

  it("hasInlinePrice is false for category copy with no {{price}} token (e.g. the EasyLoader's)", () => {
    const doc = quotationDoc({
      items: [
        quotationItem({
          code: "EL-2020",
          kind: "TABLE",
          seriesQuoteDescription: "Automates fabric loading.",
        }),
      ],
    });
    const data = buildQuotationData(doc, []);
    expect(data.machineSections[0].hasInlinePrice).toBe(false);
    // sectionPrice is still exposed structurally even though showItemPrices
    // is off in this fixture's baseDoc default — hasInlinePrice is
    // independent of whether the price is actually visible.
  });

  it("hasInlinePrice is false for a section whose category has no copy (e.g. L-Series)", () => {
    const doc = quotationDoc({ items: [lSeriesItem()] });
    const data = buildQuotationData(doc, []);
    expect(data.machineSections[0].hasInlinePrice).toBe(false);
    expect(data.machineSections[0].titleBlockHtml).toBeNull();
  });
});

// --- buildQuotationData: preparedBy / notesHtml -----------------------------

describe("buildQuotationData — preparedBy / notesHtml", () => {
  it("passes the document author through as preparedBy", () => {
    const doc = quotationDoc({ author: { name: "Jane Author", email: "jane@example.com", phone: "0400 000 000", avatar: null } });
    const data = buildQuotationData(doc, []);
    expect(data.preparedBy).toEqual({
      name: "Jane Author",
      email: "jane@example.com",
      phone: "0400 000 000",
      avatar: null,
    });
  });

  it("renders notes to HTML via renderMarkdown when present", () => {
    const doc = quotationDoc({ notes: "**Important:** handle with care." });
    const data = buildQuotationData(doc, []);
    expect(data.notesHtml).toContain("<strong>Important:</strong>");
  });

  it("is null when there are no notes", () => {
    const doc = quotationDoc({ notes: null });
    const data = buildQuotationData(doc, []);
    expect(data.notesHtml).toBeNull();
  });
});

// A product's own `description` is snapshotted onto `DocumentItem.description`
// when it's added to a quote (see `addItem`), and — since ProductForm now
// edits it with the `RichTextEditor` — can carry admin-authored HTML, not
// just plain text. `data.items[i].descriptionHtml` (consumed by the
// Investment Summary in quotation-sheet.tsx) is where that gets rendered
// through the same `renderStoredRichText` path every other stored body does.
describe("buildQuotationData — item descriptionHtml", () => {
  it("renders a legacy plain-text item description through renderMarkdown", () => {
    const doc = quotationDoc({
      items: [quotationItem({ name: "X-5180 Cutting System", description: "Ships with mounting bracket" })],
    });
    const data = buildQuotationData(doc, []);
    expect(data.items[0].descriptionHtml).toBe("<p>Ships with mounting bracket</p>");
  });

  it("sanitizes an HTML item description (from the RichTextEditor) rather than passing it through unsanitized", () => {
    const doc = quotationDoc({
      items: [
        quotationItem({
          name: "X-5180 Cutting System",
          description: "<p>Hi</p><script>alert(1)</script>",
        }),
      ],
    });
    const data = buildQuotationData(doc, []);
    expect(data.items[0].descriptionHtml).toContain("<p>Hi</p>");
    expect(data.items[0].descriptionHtml).not.toContain("<script");
  });

  it("is null when the item has no description", () => {
    const doc = quotationDoc({ items: [quotationItem({ description: null })] });
    const data = buildQuotationData(doc, []);
    expect(data.items[0].descriptionHtml).toBeNull();
  });

  it("is null when the description is redundant with the item's own name (deduped by toSheetData)", () => {
    const doc = quotationDoc({
      items: [quotationItem({ name: "X-5180 Cutting System", description: "X-5180 Cutting System" })],
    });
    const data = buildQuotationData(doc, []);
    expect(data.items[0].descriptionHtml).toBeNull();
  });
});

// Commit: "a setup image on the quotation's first page" — buildQuotationData
// carries `heroImageUrl` through `toSheetData`'s own `resolveImage`
// resolution (see tests/sheet-data.test.ts for that mapper-level assertion)
// straight onto `QuotationData.heroImage`, exactly like `logo`.
describe("buildQuotationData — hero image", () => {
  it("resolves the document's hero image through resolveImage onto QuotationData.heroImage", () => {
    const doc = quotationDoc({ heroImageUrl: "/api/files/setup.jpg" });
    const data = buildQuotationData(doc, [], { resolveImage: (url) => `resolved:${url}` });
    expect(data.heroImage).toBe("resolved:/api/files/setup.jpg");
  });

  it("is null when the document has no hero image", () => {
    const doc = quotationDoc({ heroImageUrl: null });
    const data = buildQuotationData(doc, []);
    expect(data.heroImage).toBeNull();
  });
});
