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

// --- buildQuotationData: light integration coverage -------------------------

// `{{price}}` deliberately lives on its own line/paragraph (blank line
// before it) — mirrors the real machine.m-series seed body's own
// "**Price: {{price}}**" paragraph (see prisma/seed-data/content-blocks.json)
// so hiding the price strips only that one line, never the model/height/
// width line above it.
const machineBlock: ContentBlockRow = {
  key: "machine.m-series",
  regionId: null,
  title: "M-Series",
  body: "Model {{model}}. Height {{cutHeightCm}}cm, width {{cutWidthCm}}cm.\n\nPrice: {{price}}",
  sortOrder: 1,
};

const mtsBlock: ContentBlockRow = {
  key: "option.MTS",
  regionId: null,
  title: "MTS",
  body: "Travel {{metres}}m over {{tables}} tables.",
  sortOrder: 2,
};

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

/** An L-Series cutter: width only, no lay height, no content block of its
 * own. */
const lSeriesItem = (overrides: Partial<QuotationItemInput> = {}) =>
  quotationItem({
    code: "L-320",
    name: "L-320 Cutting System",
    seriesName: "L-Series",
    specs: { cutWidthCm: 320, widthCode: 320 },
    contentBlockKey: null,
    ...overrides,
  });

describe("buildQuotationData — machine specs", () => {
  it("reads cutHeightCm/cutWidthCm from the product's specs, never from its code", () => {
    // The code says "M3390"; the column says 99 x 99. The column wins — the
    // code is a label now (see src/lib/validation/product-specs.ts).
    const doc = quotationDoc({
      items: [quotationItem({ code: "M3390", specs: { cutHeightCm: 99, cutWidthCm: 99 } })],
    });
    const data = buildQuotationData(doc, [machineBlock]);
    expect(data.machineSections[0].titleBlockHtml).toContain("Height 99cm, width 99cm");
  });

  it("line-strips the height/width line (never a blank) when the product records no specs", () => {
    const twoLineBlock: ContentBlockRow = {
      ...machineBlock,
      body: "Model {{model}}.\n\nHeight {{cutHeightCm}}cm, width {{cutWidthCm}}cm.",
    };
    const doc = quotationDoc({ items: [quotationItem({ code: "M999", specs: null })] });
    const data = buildQuotationData(doc, [twoLineBlock]);
    expect(data.machineSections[0].titleBlockHtml).toContain("Model M999");
    expect(data.machineSections[0].titleBlockHtml).not.toContain("Height");
    expect(data.machineSections[0].titleBlockHtml).not.toContain("____");
  });

  it("tolerates specs that fail validation (treated as none)", () => {
    const doc = quotationDoc({ items: [quotationItem({ specs: { cutHeightCm: "three", bogus: 1 } })] });
    const data = buildQuotationData(doc, [machineBlock]);
    expect(data.machineSections[0].titleBlockHtml).not.toContain("Height");
    expect(data.machineSections[0].specSentence).toBeNull();
  });

  it("exposes specSentence on the machine section from the specs and the series name", () => {
    const doc = quotationDoc({ items: [quotationItem({ code: "M3390", specs: { cutHeightCm: 3, cutWidthCm: 390 } })] });
    const data = buildQuotationData(doc, [machineBlock]);
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

  it("exposes specSentence for an L-Series machine even with no matching content block", () => {
    const doc = quotationDoc({ items: [lSeriesItem()] });
    const data = buildQuotationData(doc, []);
    expect(data.machineSections[0].specSentence).toBe("L-Series Cutting Machine with 320cm cutting width");
    // No `machine.*`/etc. content block covers L-Series at all — verify the
    // blockless-item case still surfaces a real spec sentence rather than
    // being left null/blank.
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
          contentBlockKey: "software.pathworks-s",
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
          contentBlockKey: "equipment.fabric-pro",
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
    const elBlock: ContentBlockRow = {
      key: "equipment.easy-loader",
      regionId: null,
      title: "Easy-Loader",
      body: "Table width {{tableWidthMm}}mm.",
      sortOrder: 1,
    };
    const doc = quotationDoc({
      items: [
        quotationItem({
          code: "EL-2020",
          name: "EasyLoader 2020",
          kind: "TABLE",
          seriesName: "EasyLoader",
          specs: { tableWidthMm: 2020 },
          contentBlockKey: "equipment.easy-loader",
        }),
      ],
    });
    const data = buildQuotationData(doc, [elBlock]);
    expect(data.machineSections[0].titleBlockHtml).toContain("Table width 2020mm");
  });
});

describe("buildQuotationData", () => {
  it("resolves a machine title block with substituted vars", () => {
    // `model` is substituted with the raw `item.code` (e.g. "M5180") as-is —
    // the real machine.m-series seed template (see
    // prisma/seed-data/content-blocks.json) uses a bare "{{model}}" (no
    // hardcoded "M" prefix), so a full product code renders correctly with
    // no doubled "M". This fixture's own block body mirrors that shape.
    const data = buildQuotationData(quotationDoc({ items: [quotationItem({ code: "M450" })] }), [machineBlock]);
    expect(data.machineSections).toHaveLength(1);
    expect(data.machineSections[0].titleBlockHtml).toContain("Model M450");
    expect(data.machineSections[0].titleBlockHtml).toContain("Height 18cm, width 180cm");
  });

  it("leaves titleBlockHtml null for a product with no content block key", () => {
    const doc = quotationDoc({ items: [quotationItem({ code: "EF-100", kind: "FEEDER", contentBlockKey: null })] });
    const data = buildQuotationData(doc, [machineBlock]);
    expect(data.machineSections[0].titleBlockHtml).toBeNull();
  });

  it("leaves titleBlockHtml null when the product's content block key matches no block in the library", () => {
    const doc = quotationDoc({ items: [quotationItem({ contentBlockKey: "equipment.fabric-pro" })] });
    const data = buildQuotationData(doc, [machineBlock]);
    expect(data.machineSections[0].titleBlockHtml).toBeNull();
  });

  it("resolves the title block by the product's contentBlockKey, not by its code or series", () => {
    const punchlineBlock: ContentBlockRow = {
      key: "equipment.punchline",
      regionId: null,
      title: "Punchline",
      body: "Paper width {{paperWidthMm}}mm.",
      sortOrder: 1,
    };
    // A machine-series code wearing the punchline key still gets the
    // punchline block: the key is the whole rule.
    const doc = quotationDoc({
      items: [quotationItem({ code: "M5180", contentBlockKey: "equipment.punchline", specs: { paperWidthMm: 1880 } })],
    });
    const data = buildQuotationData(doc, [machineBlock, punchlineBlock]);
    expect(data.machineSections[0].titleBlockHtml).toContain("Paper width 1880mm");
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
      items: [quotationItem({ code: "M450" })],
    });
    const data = buildQuotationData(doc, [machineBlock]);
    expect(data.machineSections[0].titleBlockHtml).not.toContain("Price");
    expect(data.machineSections[0].titleBlockHtml).not.toContain("____");
    // The rest of the block (a separate line) still renders untouched.
    expect(data.machineSections[0].titleBlockHtml).toContain("Height 18cm, width 180cm");
  });

  it("substitutes the item's TOTAL (incl. options), currency-formatted, when showItemPrices is on", () => {
    const doc = quotationDoc({
      showItemPrices: true,
      showOptionPrices: false,
      items: [quotationItem({ unitPrice: "175000.00", total: "180000.00" })],
    });
    const data = buildQuotationData(doc, [machineBlock]);
    // Uses the pricing engine's per-item TOTAL (180000, incl. an option),
    // not the bare unit price (175000) — and formatted via formatMoney, not
    // a raw decimal string.
    expect(data.machineSections[0].titleBlockHtml).toContain("Price: $180,000");
    expect(data.machineSections[0].titleBlockHtml).not.toContain("175000");
  });

  it("substitutes {{basePrice}} with the machine's own price, distinct from the combined {{price}} total", () => {
    const basePriceBlock: ContentBlockRow = {
      key: "machine.m-series",
      regionId: null,
      title: "M-Series",
      body: "Base: {{basePrice}}\n\nTotal: {{price}}",
      sortOrder: 1,
    };
    const doc = quotationDoc({
      showItemPrices: true,
      showOptionPrices: false,
      items: [quotationItem({ unitPrice: "175000.00", total: "180000.00" })],
    });
    const data = buildQuotationData(doc, [basePriceBlock]);
    // {{basePrice}} resolves to the bare machine price (175000), while the
    // pre-existing {{price}} keeps meaning the combined subtotal (180000,
    // incl. the option) — so catalogue templates that already reference
    // {{price}} keep working unchanged.
    expect(data.machineSections[0].titleBlockHtml).toContain("Base: $175,000");
    expect(data.machineSections[0].titleBlockHtml).toContain("Total: $180,000");
  });

  it("strips the {{basePrice}} line (never a blank) when both price-display toggles are off", () => {
    const basePriceBlock: ContentBlockRow = {
      key: "machine.m-series",
      regionId: null,
      title: "M-Series",
      body: "Model {{model}}.\n\nBase: {{basePrice}}",
      sortOrder: 1,
    };
    const doc = quotationDoc({
      showItemPrices: false,
      showOptionPrices: false,
      items: [quotationItem({ code: "M450" })],
    });
    const data = buildQuotationData(doc, [basePriceBlock]);
    expect(data.machineSections[0].titleBlockHtml).not.toContain("Base");
    expect(data.machineSections[0].titleBlockHtml).not.toContain("____");
    expect(data.machineSections[0].titleBlockHtml).toContain("Model M450");
  });

  it("substitutes the real price when only showOptionPrices is on (implies item prices visible)", () => {
    const doc = quotationDoc({ showItemPrices: false, showOptionPrices: true });
    const data = buildQuotationData(doc, [machineBlock]);
    expect(data.machineSections[0].titleBlockHtml).toContain("Price: $175,000");
  });

  it("passes both price-display toggles through onto the returned QuotationData", () => {
    const doc = quotationDoc({ showItemPrices: true, showOptionPrices: false });
    const data = buildQuotationData(doc, []);
    expect(data.showItemPrices).toBe(true);
    expect(data.showOptionPrices).toBe(false);
  });

  it("resolves OPTION lines to option blocks using line attributes, falls back for lines with no match", () => {
    const doc = quotationDoc({
      items: [
        quotationItem({
          lines: [
            {
              id: "line-1",
              kind: "OPTION",
              code: "MTS",
              name: "Machine Transfer System",
              description: null,
              qty: 1,
              unitPrice: "5000.00",
              attributes: { metres: 4, tables: 2 },
              contentBlockKey: "option.MTS",
              imageUrl: null,
            },
            {
              id: "line-2",
              kind: "OPTION",
              code: "ZZZ-NOPE",
              name: "Unknown option",
              description: null,
              qty: 1,
              unitPrice: "0.00",
              attributes: null,
              contentBlockKey: null,
              imageUrl: null,
            },
          ],
        }),
      ],
    });
    const data = buildQuotationData(doc, [machineBlock, mtsBlock]);
    const rows = data.machineSections[0].optionRows;
    // Both lines land as rows in the ONE unified table — a matched block and
    // an unmatched code no longer render through two different code paths.
    expect(rows).toHaveLength(2);
    expect(rows[0].descriptionHtml).toContain("Travel 4m over 2 tables");
    // A line whose code matches no option.* block is never silently
    // dropped — it still gets its own row in the same table (owner: "no
    // selected option may be silently omitted").
    expect(rows[1]).toMatchObject({
      code: "ZZZ-NOPE",
      name: "Unknown option",
      qty: 1,
    });
  });

  it("no selected option is ever omitted: 3 options (1 with a block, 2 without) all appear in the one unified table", () => {
    const doc = quotationDoc({
      showOptionPrices: true,
      items: [
        quotationItem({
          lines: [
            {
              id: "line-1",
              kind: "OPTION",
              code: "MTS",
              name: "Machine Transfer System",
              description: null,
              qty: 1,
              unitPrice: "5000.00",
              attributes: { metres: 4, tables: 2 },
              contentBlockKey: "option.MTS",
              imageUrl: null,
            },
            {
              id: "line-2",
              kind: "OPTION",
              code: "UNMATCHED-1",
              name: "First unmatched option",
              description: null,
              qty: 2,
              unitPrice: "570.00",
              attributes: null,
              contentBlockKey: null,
              imageUrl: null,
            },
            {
              id: "line-3",
              kind: "OPTION",
              code: null,
              name: "Second unmatched option",
              description: null,
              qty: 1,
              unitPrice: "100.00",
              attributes: { colour: "Blue" },
              contentBlockKey: null,
              imageUrl: null,
            },
          ],
        }),
      ],
    });
    const data = buildQuotationData(doc, [machineBlock, mtsBlock]);
    const rows = data.machineSections[0].optionRows;

    // All 3 selected options are accounted for, in line order, in the one
    // unified table — none silently dropped just because its code didn't
    // resolve to an option.* content block.
    expect(rows.map((r) => r.name)).toEqual([
      "Machine Transfer System",
      "First unmatched option",
      "Second unmatched option",
    ]);
    expect(rows).toHaveLength(3);

    // The matched-block row still renders its block body as descriptionHtml,
    // and — unlike the old optionBlocksHtml, which never showed a price at
    // all — now gets the same price column every row gets (gated by
    // showOptionPrices, same as before).
    expect(rows[0].descriptionHtml).toContain("Travel 4m over 2 tables");
    expect(rows[0].price).toBe("$5,000");

    // qty >1 and price (gated by showOptionPrices) both surface on an
    // unmatched row.
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
              code: "UNMATCHED",
              name: "Unmatched option",
              description: null,
              qty: 1,
              unitPrice: "100.00",
              attributes: null,
              contentBlockKey: null,
              imageUrl: null,
            },
          ],
        }),
      ],
    });
    const data = buildQuotationData(doc, []);
    expect(data.machineSections[0].optionRows[0].price).toBeNull();
  });

  it("carries qty onto a matched-block option row (for the table's qty column)", () => {
    const doc = quotationDoc({
      items: [
        quotationItem({
          lines: [
            {
              id: "line-1",
              kind: "OPTION",
              code: "MTS",
              name: "Machine Transfer System",
              description: null,
              qty: 3,
              unitPrice: "5000.00",
              attributes: { metres: 4, tables: 2 },
              contentBlockKey: "option.MTS",
              imageUrl: null,
            },
          ],
        }),
      ],
    });
    const data = buildQuotationData(doc, [machineBlock, mtsBlock]);
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
// that always runs, for every section, block or no block.
describe("buildQuotationData — sectionTitle", () => {
  // Owner rule change: a matched block's STATIC title (no {{placeholder}} at
  // all, like machineBlock's plain "M-Series") is never trusted as the
  // heading any more, even though a block matched — this is what let a
  // generic content-block title (e.g. "Easy-Loader #1") leak onto the sheet
  // as if it were that specific item's name. Only a DYNAMIC title (one that
  // references a placeholder, e.g. "Pathfinder {{model}} Cutting System" —
  // see the next test) still gets used, substituted.
  it("ignores a matched content block's static title, always uses the item's own name instead", () => {
    const data = buildQuotationData(quotationDoc({ items: [quotationItem({ code: "M450" })] }), [machineBlock]);
    expect(data.machineSections[0].sectionTitle).toBe("M5180 Cutting System");
  });

  it("substitutes placeholders in the block's title (e.g. {{model}}), same vars as the body", () => {
    const modelTitleBlock: ContentBlockRow = {
      key: "machine.m-series",
      regionId: null,
      title: "Pathfinder {{model}} Cutting System",
      body: "Model {{model}}.",
      sortOrder: 1,
    };
    const data = buildQuotationData(
      quotationDoc({ items: [quotationItem({ code: "X-5180", seriesName: "X-Calibre" })] }),
      [modelTitleBlock]
    );
    expect(data.machineSections[0].sectionTitle).toBe("Pathfinder X-5180 Cutting System");
  });

  it("falls back to the item's name when no content block matches the product", () => {
    const doc = quotationDoc({
      items: [quotationItem({ code: "EF-100", name: "EF-100 Accessory", kind: "FEEDER", contentBlockKey: null })],
    });
    const data = buildQuotationData(doc, [machineBlock]);
    expect(data.machineSections[0].sectionTitle).toBe("EF-100 Accessory");
  });

  it("falls back to the item's name for a blockless product (e.g. L-Series)", () => {
    const doc = quotationDoc({ items: [lSeriesItem()] });
    const data = buildQuotationData(doc, []);
    expect(data.machineSections[0].sectionTitle).toBe("L-320 Cutting System");
  });

  it("falls back to the item's name when the matched block has a title but no body-matching text (null title)", () => {
    const noTitleBlock: ContentBlockRow = {
      key: "machine.m-series",
      regionId: null,
      title: null,
      body: "Model {{model}}.",
      sortOrder: 1,
    };
    const doc = quotationDoc({ items: [quotationItem({ name: "M5180 Cutting System" })] });
    const data = buildQuotationData(doc, [noTitleBlock]);
    expect(data.machineSections[0].sectionTitle).toBe("M5180 Cutting System");
  });

  it("falls back to the item's name when the title's only content is an unresolved placeholder", () => {
    const unresolvedTitleBlock: ContentBlockRow = {
      key: "machine.m-series",
      regionId: null,
      title: "{{rspUnitCost}}",
      body: "Model {{model}}.",
      sortOrder: 1,
    };
    const doc = quotationDoc({ items: [quotationItem({ name: "M5180 Cutting System" })] });
    const data = buildQuotationData(doc, [unresolvedTitleBlock]);
    expect(data.machineSections[0].sectionTitle).toBe("M5180 Cutting System");
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
  it("resolves a matched option's imageUrl through the same resolver as item images (icon flow: query -> data -> sheet)", () => {
    const doc = quotationDoc({
      items: [
        quotationItem({
          lines: [
            {
              id: "line-1",
              kind: "OPTION",
              code: "MTS",
              name: "Machine Transfer System",
              description: null,
              qty: 1,
              unitPrice: "5000.00",
              attributes: null,
              contentBlockKey: "option.MTS",
              imageUrl: "/api/files/mts-icon.png",
            },
          ],
        }),
      ],
    });
    const data = buildQuotationData(doc, [machineBlock, mtsBlock], {
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
              code: "MTS",
              name: "Machine Transfer System",
              description: null,
              qty: 1,
              unitPrice: "5000.00",
              attributes: null,
              contentBlockKey: "option.MTS",
              imageUrl: null,
            },
          ],
        }),
      ],
    });
    const data = buildQuotationData(doc, [machineBlock, mtsBlock]);
    expect(data.machineSections[0].optionRows[0].icon).toBeNull();
  });

  it("resolves the option block by the line's contentBlockKey, not by its code", () => {
    const abrBlock: ContentBlockRow = {
      key: "option.ABR",
      regionId: null,
      title: "ABR",
      body: "Automatic blade replacement.",
      sortOrder: 1,
    };
    const doc = quotationDoc({
      items: [
        quotationItem({
          lines: [
            {
              id: "line-1",
              kind: "OPTION",
              code: "ABR-M", // no "option.ABR-M" block exists; the key says option.ABR
              name: "Automatic Blade Replacement",
              description: "Snapshot description",
              qty: 1,
              unitPrice: "1000.00",
              attributes: null,
              contentBlockKey: "option.ABR",
              imageUrl: null,
            },
            {
              id: "line-2",
              kind: "OPTION",
              code: "MTS", // an option.MTS block exists, but this line's option has no key
              name: "Machine Transfer System",
              description: "Snapshot description",
              qty: 1,
              unitPrice: "5000.00",
              attributes: null,
              contentBlockKey: null,
              imageUrl: null,
            },
          ],
        }),
      ],
    });
    const data = buildQuotationData(doc, [abrBlock, mtsBlock]);
    const rows = data.machineSections[0].optionRows;
    expect(rows[0].descriptionHtml).toContain("Automatic blade replacement");
    expect(rows[1].descriptionHtml).toContain("Snapshot description");
    expect(rows[1].descriptionHtml).not.toContain("Travel");
  });

  it("dedupes the row's own code when it's redundant with its name", () => {
    const doc = quotationDoc({
      items: [
        quotationItem({
          lines: [
            {
              id: "line-1",
              kind: "OPTION",
              code: "ZZZ-NOPE", // no option.* block matches (see mtsBlock's key)
              name: "ZZZ-NOPE",
              description: null,
              qty: 1,
              unitPrice: "0.00",
              attributes: null,
              contentBlockKey: null,
              imageUrl: null,
            },
          ],
        }),
      ],
    });
    const data = buildQuotationData(doc, []);
    expect(data.machineSections[0].optionRows[0]).toMatchObject({ code: null, name: "ZZZ-NOPE" });
  });

  it("falls back to the line's own (deduped) description when no option.* block matches", () => {
    const doc = quotationDoc({
      items: [
        quotationItem({
          lines: [
            {
              id: "line-1",
              kind: "OPTION",
              code: "UNMATCHED",
              name: "Unmatched option",
              description: "A short freeform description",
              qty: 1,
              unitPrice: "0.00",
              attributes: null,
              contentBlockKey: null,
              imageUrl: null,
            },
          ],
        }),
      ],
    });
    const data = buildQuotationData(doc, []);
    expect(data.machineSections[0].optionRows[0].descriptionHtml).toContain("A short freeform description");
  });

  it("descriptionHtml is null when there's no block AND the line's description is redundant with its name", () => {
    const doc = quotationDoc({
      items: [
        quotationItem({
          lines: [
            {
              id: "line-1",
              kind: "OPTION",
              code: "UNMATCHED",
              name: "Unmatched option",
              description: "Unmatched option", // identical to name -> deduped away
              qty: 1,
              unitPrice: "0.00",
              attributes: null,
              contentBlockKey: null,
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
              code: "MTS",
              name: "Machine Transfer System",
              description: null,
              qty: 1,
              unitPrice: "5000.00",
              attributes: { metres: 4, tables: 2 },
              contentBlockKey: "option.MTS",
              imageUrl: null,
            },
            {
              id: "line-2",
              kind: "OPTION",
              code: "UNMATCHED",
              name: "Unmatched option",
              description: null,
              qty: 1,
              unitPrice: "0.00",
              attributes: null,
              contentBlockKey: null,
              imageUrl: null,
            },
          ],
        }),
      ],
    });
    const data = buildQuotationData(doc, [machineBlock, mtsBlock]);
    const rows = data.machineSections[0].optionRows;
    expect(rows[0].attributesLine).toBe("metres: 4 · tables: 2");
    expect(rows[1].attributesLine).toBeNull();
  });

  it("gates every row's price on showOptionPrices, including a matched-block row (previously never priced)", () => {
    const line: QuotationItemInput["lines"][number] = {
      id: "line-1",
      kind: "OPTION",
      code: "MTS",
      name: "Machine Transfer System",
      description: null,
      qty: 2,
      unitPrice: "500.00",
      attributes: null,
      contentBlockKey: "option.MTS",
      imageUrl: null,
    };

    const off = buildQuotationData(quotationDoc({ showOptionPrices: false, items: [quotationItem({ lines: [line] })] }), [
      machineBlock,
      mtsBlock,
    ]);
    expect(off.machineSections[0].optionRows[0].price).toBeNull();

    const on = buildQuotationData(quotationDoc({ showOptionPrices: true, items: [quotationItem({ lines: [line] })] }), [
      machineBlock,
      mtsBlock,
    ]);
    expect(on.machineSections[0].optionRows[0].price).toBe("$1,000");
  });
});

// --- buildQuotationData: structural section price (owner: every item
// section must show its price) ---------------------------------------------
//
// Root cause of the owner-reported missing prices: EL-2020/PTW(I)/FP-180's
// content blocks never carried a "Price: {{price}}" line the way
// machine.m-series's did, so those sections showed no price at all.
// `sectionPrice`/`hasInlinePrice` make the price structural for every
// section, while still avoiding a double print for a block (like
// machine.m-series) that already inlines its own price line.
// The Equipment Detail table repeats the machine and its price, so it has to
// follow the same rules the Investment Summary's own base row does — the two
// disagreeing is what put "$0" next to EL-2020 on one page and nothing on the
// next. See `ItemBreakdown.basePriceUnquoted` / `assembledFromOptions`.
describe("buildQuotationData — baseRow for a product with no price of its own", () => {
  const driveModule = {
    id: "line-1",
    kind: "OPTION" as const,
    code: "EL-2020 Drive Module (first 1.2M)",
    name: "Drive Module",
    description: null,
    qty: 1,
    unitPrice: "4050.00",
    attributes: null,
    contentBlockKey: null,
    imageUrl: null,
  };

  const sectionFor = (item: Partial<Parameters<typeof quotationItem>[0]>) =>
    buildQuotationData(
      quotationDoc({ showOptionPrices: true, items: [quotationItem(item)] }),
      [machineBlock]
    ).machineSections[0];

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

  it("hasInlinePrice is true for a matched block whose raw body references {{price}} (machine.m-series)", () => {
    const doc = quotationDoc({ items: [quotationItem({ code: "M450" })] });
    const data = buildQuotationData(doc, [machineBlock]);
    expect(data.machineSections[0].hasInlinePrice).toBe(true);
  });

  it("hasInlinePrice is false for a matched block with no {{price}} token (e.g. equipment.easy-loader)", () => {
    const elBlock: ContentBlockRow = {
      key: "equipment.easy-loader",
      regionId: null,
      title: "Easy-Loader",
      body: "Automates fabric loading.",
      sortOrder: 1,
    };
    const doc = quotationDoc({
      items: [quotationItem({ code: "EL-2020", kind: "TABLE", contentBlockKey: "equipment.easy-loader" })],
    });
    const data = buildQuotationData(doc, [elBlock]);
    expect(data.machineSections[0].hasInlinePrice).toBe(false);
    // sectionPrice is still exposed structurally even though showItemPrices
    // is off in this fixture's baseDoc default — hasInlinePrice is
    // independent of whether the price is actually visible.
  });

  it("hasInlinePrice is false for a blockless section (e.g. L-Series)", () => {
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
