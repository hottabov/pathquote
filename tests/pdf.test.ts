import { describe, it, expect } from "vitest";
import { buildFooterHtml, quotationPdfFilename, renderQuotationHtml } from "../src/lib/pdf";
import { buildItemBreakdown } from "../src/lib/sheet-data";
import { computeTotals, DEFAULT_COMMISSION_TIERS } from "../src/lib/pricing";
import type { QuotationData } from "../src/lib/quotation-data";

// Pure/rendering bits of the PDF pipeline only — `htmlToPdf` and
// `fileImageResolver` need a live Gotenberg / real uploaded files
// respectively and are code-verified rather than exercised here (see the
// plan's Task C note: no live Gotenberg in this environment).

describe("buildFooterHtml", () => {
  it("sends a footer with the quote number and page numbers", () => {
    const footer = buildFooterHtml("Q-AU-2026-001");
    expect(footer).toContain("Q-AU-2026-001");
    expect(footer).toContain('class="pageNumber"');
    expect(footer).toContain('class="totalPages"');
  });

  it("falls back to 'Draft' when there is no document number yet", () => {
    const footer = buildFooterHtml(null);
    expect(footer).toContain("Draft");
  });

  it("HTML-escapes the document number rather than trusting its format", () => {
    const footer = buildFooterHtml('<script>alert(1)</script>');
    expect(footer).not.toContain("<script>alert(1)</script>");
    expect(footer).toContain("&lt;script&gt;");
  });
});

describe("quotationPdfFilename", () => {
  it("uses the document number when present", () => {
    expect(quotationPdfFilename("Q-AU-2026-001")).toBe("Q-AU-2026-001-quotation.pdf");
  });

  it("falls back to draft-quotation when there is no number yet", () => {
    expect(quotationPdfFilename(null)).toBe("draft-quotation.pdf");
  });

  it("sanitizes characters that could break a Content-Disposition header", () => {
    expect(quotationPdfFilename('evil"; x=1\r\nSet-Cookie: y')).toBe(
      "evil_x_1_Set-Cookie_y-quotation.pdf"
    );
  });
});

// --- renderQuotationHtml -----------------------------------------------------

function baseQuotationData(overrides: Partial<QuotationData> = {}): QuotationData {
  return {
    isDraft: false,
    number: "Q-AU-2026-001",
    issueDate: "30/08/2026",
    validityDate: null,
    logo: null,
    heroImage: null,
    entity: {
      name: "Pathfinder Cutting Systems",
      legalId: "ABN 123",
      address: "1 Example St",
      bankDetails: [],
      footerText: null,
    },
    client: null,
    delivery: null,
    preparedBy: { name: "Jane Author", email: "jane@example.com", phone: "0400 000 000", avatar: null },
    notesHtml: null,
    machineSections: [],
    strippedTokens: [],
    items: [],
    extraLines: [],
    totals: {
      currency: "AUD",
      subtotal: "1000.00",
      discountMode: "PERCENT",
      discountValue: null,
      discountAmount: "0.00",
      taxName: "GST",
      taxRate: "10",
      taxAmount: "100.00",
      total: "1100.00",
      deliveryTerms: "DELIVERED",
    },
    termsSections: [],
    conditionsSections: [],
    rsp: { agreementHtml: null, coverageRows: [] },
    showSignature: true,
    showItemPrices: true,
    showOptionPrices: true,
    signatures: { author: null, client: null },
    ...overrides,
  };
}

// `breakdown` is derived via the same `buildItemBreakdown` helper
// `toSheetData` itself uses (rather than a hand-maintained fixture) so it
// never drifts out of sync with whatever `unitPrice`/`lines`/`total`/
// discount fields a test overrides — a caller can still override
// `breakdown` explicitly when a test wants to exercise a shape
// `buildItemBreakdown` wouldn't itself produce.
//
// `isCredit` isn't a field of `QuotationData["items"][number]` (= `DocSheetItem`
// — see `sheet-data.ts`; the sign is already baked into `breakdown` by the
// time it gets there) — it's accepted here as an extra, breakdown-only input
// so a test can drive `buildItemBreakdown`'s own `isCredit` sign without
// having to hand-build `breakdown` itself. Defaults to `false`, same as
// `ToSheetItemInput.isCredit` everywhere else.
function baseDocSheetItem(
  overrides: Partial<QuotationData["items"][number]> & { isCredit?: boolean } = {}
): QuotationData["items"][number] {
  const { isCredit = false, ...rest } = overrides;
  const merged = {
    id: "item-1",
    code: "X-5180",
    name: "X-5180 Cutting System",
    description: null,
    descriptionHtml: null,
    unitPrice: "175000.00",
    discountMode: "PERCENT" as const,
    discountValue: null,
    total: "215425.00",
    image: null,
    lines: [],
    ...rest,
  };
  return {
    ...merged,
    breakdown:
      overrides.breakdown ??
      buildItemBreakdown(
        {
          unitPrice: merged.unitPrice,
          listPrice: merged.unitPrice,
          discountMode: merged.discountMode,
          discountValue: merged.discountValue,
          discountAmount: "0.00",
          total: merged.total,
          lines: merged.lines,
          isCredit,
        },
        true
      ),
  };
}

describe("renderQuotationHtml — page wrapping", () => {
  it("wraps the sheet in a full standalone HTML document", async () => {
    const html = await renderQuotationHtml(baseQuotationData());

    expect(html).toContain("<!doctype html>");
    expect(html).toContain('<meta charSet="utf-8">');
    expect(html).toContain("@page{size:A4;margin:15mm}");
    expect(html).toContain("Pathfinder Cutting Systems");
    expect(html).toContain("Q-AU-2026-001");
  });

  it("renders a multi-line entity address as one pq-entity-line div per line, not a literal newline", async () => {
    const html = await renderQuotationHtml(
      baseQuotationData({
        entity: {
          name: "Pathfinder Cutting Systems",
          legalId: "ABN 123",
          address: "12 Dib Court\nTullamarine, VIC 3043, Australia\nWeb: pathfindercut.com",
          bankDetails: [],
          footerText: null,
        },
      })
    );

    // Each address line lands in its own element rather than a single block
    // with an embedded "\n" (which HTML would collapse to a single space).
    expect(html).toContain('<div class="pq-entity-line">12 Dib Court</div>');
    expect(html).toContain('<div class="pq-entity-line">Tullamarine, VIC 3043, Australia</div>');
    expect(html).toContain('<div class="pq-entity-line">Web: pathfindercut.com</div>');
    expect(html).not.toContain("Dib Court\\n");
  });
});

// Commit: "a setup image on the quotation's first page" — placed after the
// header detail (entity / prepared for / prepared by / delivery) and before
// the Total investment banner (owner: "the customer sees what they are
// buying, then the price"). No frame/caption/placeholder when unset — a
// quote without a hero image must look finished, not unfinished.
describe("renderQuotationHtml — hero (setup) image", () => {
  it("renders the hero image as an <img> between the header detail and the Total investment banner", async () => {
    const data = baseQuotationData({ heroImage: "data:image/jpeg;base64,AAAA" });
    const html = await renderQuotationHtml(data);

    expect(html).toContain('<img src="data:image/jpeg;base64,AAAA"');
    expect(html).toContain('class="pq-hero-image"');

    const heroIdx = html.indexOf('class="pq-hero-image"');
    const bannerIdx = html.indexOf("Total investment");
    expect(heroIdx).toBeGreaterThan(-1);
    expect(bannerIdx).toBeGreaterThan(heroIdx);
  });

  it("already carries a fully-inlined data: URI, never the stored /api/files/... URL — the PDF pipeline resolves it before rendering", async () => {
    // `buildQuotationData`/`toSheetData` are responsible for running
    // `heroImageUrl` through the caller's `ImageResolver` (see
    // tests/quotation-data.test.ts and tests/sheet-data.test.ts) — by the
    // time `QuotationData` reaches this renderer, `heroImage` is already
    // whatever the resolver produced. This asserts the renderer just embeds
    // it verbatim as an <img src>, so a data: URI here really does end up
    // inlined in the PDF's HTML rather than left as a URL Gotenberg's
    // headless Chromium (no session cookie) could never fetch.
    const data = baseQuotationData({ heroImage: "data:image/jpeg;base64,RESOLVEDBYTES" });
    const html = await renderQuotationHtml(data);
    expect(html).toContain('<img src="data:image/jpeg;base64,RESOLVEDBYTES"');
    expect(html).not.toContain("/api/files/");
  });

  it("renders no <img> at all — no frame, no caption, no placeholder — when the document has no hero image", async () => {
    const html = await renderQuotationHtml(baseQuotationData({ heroImage: null }));
    // The embedded <style> block always defines .pq-hero-image regardless
    // (static CSS) — assert on the actual element, not the bare class name.
    expect(html).not.toContain('class="pq-hero-image"');
    // baseQuotationData's logo/avatar are also both null, so no <img> at all
    // should appear anywhere on the page.
    expect(html).not.toContain("<img");
  });
});

describe("renderQuotationHtml — header prepared for/by", () => {
  it("renders 'Prepared for' and 'Prepared by' as two columns", async () => {
    const data = baseQuotationData({
      client: {
        companyName: "Acme Pty Ltd",
        addressLines: ["1 Example Rd"],
        website: null,
        contactName: "John Client",
        contactEmail: null,
        contactPhone: null,
      },
      preparedBy: { name: "Jane Author", email: "jane@example.com", phone: "0400 000 000", avatar: null },
    });
    const html = await renderQuotationHtml(data);
    expect(html).toContain("Prepared for");
    expect(html).toContain("Acme Pty Ltd");
    expect(html).toContain("Prepared by");
    expect(html).toContain("Jane Author");
    expect(html).toContain("0400 000 000");
    expect(html).not.toContain("Bill To");
  });

  it("renders the author's avatar under Prepared by when present", async () => {
    const data = baseQuotationData({
      preparedBy: {
        name: "Jane Author",
        email: "jane@example.com",
        phone: "0400 000 000",
        avatar: "data:image/jpeg;base64,AAAA",
      },
    });
    const html = await renderQuotationHtml(data);
    expect(html).toContain('<img src="data:image/jpeg;base64,AAAA"');
    expect(html).toContain('class="pq-prepared-by-avatar"');
  });

  it("renders no <img> for Prepared by when the author has no avatar", async () => {
    const data = baseQuotationData({
      preparedBy: { name: "Jane Author", email: "jane@example.com", phone: "0400 000 000", avatar: null },
    });
    const html = await renderQuotationHtml(data);
    // The embedded <style> block always defines the .pq-prepared-by-avatar
    // selector regardless — check for the element's opening tag, not the
    // bare class name.
    expect(html).not.toContain('<img class="pq-prepared-by-avatar"');
    expect(html).not.toContain("<img");
  });

  it("falls back to the author's email when no name is set", async () => {
    const data = baseQuotationData({
      preparedBy: { name: null, email: "noname@example.com", phone: null, avatar: null },
    });
    const html = await renderQuotationHtml(data);
    expect(html).toContain('<div class="pq-client-name">noname@example.com</div>');
    // The email doesn't also print a second time as its own line — that
    // second line only appears when there's a name for it to sit alongside.
    expect((html.match(/noname@example\.com/g) ?? []).length).toBe(1);
  });
});

describe("renderQuotationHtml — structural section price", () => {
  it("prints a structural price row for a blockless section", async () => {
    const data = baseQuotationData({
      machineSections: [
        {
          itemId: "item-1",
          sectionTitle: "L-320 Cutting System",
          titleBlockHtml: null,
          specSentence: "L-Series Cutting Machine with 320cm cutting width",
          sectionPrice: "$180,000",
          hasInlinePrice: false,
          baseRow: { code: "M5180", name: "M Series 5180", qty: 1, price: null },
          optionRows: [],
          lineSummary: baseDocSheetItem({ total: "180000.00" }),
        },
      ],
    });
    const html = await renderQuotationHtml(data);
    expect(html).toContain('<div class="pq-section-price">Price: $180,000</div>');
  });

  it("does not double-print the price for a section whose block already inlines it", async () => {
    const data = baseQuotationData({
      machineSections: [
        {
          itemId: "item-1",
          sectionTitle: "M5180 Cutting System",
          titleBlockHtml: "<p>Model M5180. <strong>Price: $175,000</strong></p>",
          specSentence: null,
          sectionPrice: "$175,000",
          hasInlinePrice: true,
          baseRow: { code: "M5180", name: "M Series 5180", qty: 1, price: null },
          optionRows: [],
          lineSummary: baseDocSheetItem(),
        },
      ],
    });
    const html = await renderQuotationHtml(data);
    expect(html).not.toContain('class="pq-section-price"');
    // The inline price from titleBlockHtml itself still renders exactly once.
    expect((html.match(/Price: \$175,000/g) ?? []).length).toBe(1);
  });
});

describe("renderQuotationHtml — investment summary: base price, options, subtotal, totals order", () => {
  it("shows the item's BASE unit price on the item row, not the lump-sum total", async () => {
    const data = baseQuotationData({
      items: [
        baseDocSheetItem({
          unitPrice: "175000.00",
          total: "215425.00",
          lines: [{ id: "line-1", code: "MTS", name: "Machine Transfer System", description: null, qty: 1, unitPrice: "40425.00", lineTotal: "40425.00", image: null }],
        }),
      ],
    });
    const html = await renderQuotationHtml(data);
    expect(html).toContain("$175,000");
  });

  it("shows each option's own code and description in the Investment Summary row itself, not just in Equipment Detail", async () => {
    const data = baseQuotationData({
      items: [
        baseDocSheetItem({
          code: "X-5180",
          unitPrice: "175000.00",
          total: "215425.00",
          lines: [
            {
              id: "line-1",
              code: "MTS",
              name: "Machine Transfer System",
              description: "Automated transfer of cut fabric off the table",
              qty: 1,
              unitPrice: "40425.00",
              lineTotal: "40425.00",
              image: null,
            },
          ],
        }),
      ],
    });
    const html = await renderQuotationHtml(data);
    const summaryStart = html.indexOf('class="pq-section pq-summary-section"');
    const summaryHtml = html.slice(summaryStart);

    expect(summaryStart).toBeGreaterThan(-1);
    expect(summaryHtml).toContain("MTS — Machine Transfer System");
    expect(summaryHtml).toContain("Automated transfer of cut fabric off the table");
  });

  it("renders a product's rich-text description as formatted HTML in the Investment Summary, not escaped tag soup", async () => {
    const data = baseQuotationData({
      items: [
        baseDocSheetItem({
          code: "X-5180",
          descriptionHtml: "<p>Ships with a <strong>mounting bracket</strong>.</p>",
        }),
      ],
    });
    const html = await renderQuotationHtml(data);
    const summaryStart = html.indexOf('class="pq-section pq-summary-section"');
    const summaryHtml = html.slice(summaryStart);

    // The real bold tag renders as a real tag, not HTML-escaped entities.
    expect(summaryHtml).toContain("<strong>mounting bracket</strong>");
    expect(summaryHtml).not.toContain("&lt;strong&gt;");
  });

  it("adds a per-item subtotal row (base + options) only when the item has options", async () => {
    const withOptions = await renderQuotationHtml(
      baseQuotationData({
        items: [
          baseDocSheetItem({
            code: "X-5180",
            unitPrice: "175000.00",
            total: "215425.00",
            lines: [{ id: "line-1", code: "MTS", name: "MTS", description: null, qty: 1, unitPrice: "40425.00", lineTotal: "40425.00", image: null }],
          }),
        ],
      })
    );
    expect(withOptions).toContain('class="pq-item-subtotal-row"');
    expect(withOptions).toContain("X-5180 subtotal");
    expect(withOptions).toContain("$215,425");

    const withoutOptions = await renderQuotationHtml(
      baseQuotationData({ items: [baseDocSheetItem({ code: "X-5180", lines: [] })] })
    );
    // The embedded <style> block always defines the .pq-item-subtotal-row
    // selector regardless of whether any row uses it — assert on the
    // rendered element (its class *attribute*) rather than the bare
    // substring "subtotal", which the stylesheet text alone would satisfy.
    expect(withoutOptions).not.toContain('class="pq-item-subtotal-row"');
  });

  it("prints a credit item's (TRADE-IN) base price with an explicit minus and the negative-extra-line muted styling", async () => {
    const creditItem = baseDocSheetItem({
      code: "TRADE-IN",
      name: "Trade-in",
      unitPrice: "20000.00", // typed positive -- see Product.isCredit
      total: "-20000.00", // already signed by the pricing engine
      isCredit: true,
      lines: [],
    });
    const html = await renderQuotationHtml(baseQuotationData({ items: [creditItem] }));
    const summaryStart = html.indexOf('class="pq-section pq-summary-section"');
    const summaryHtml = html.slice(summaryStart);

    expect(summaryHtml).toContain("-$20,000");
    // Same muted treatment a negative extra line already gets -- reused, not
    // a second mechanism (see item-breakdown.tsx).
    expect(summaryHtml).toContain('class="pq-col-amount pq-amount pq-negative"');
  });

  it("an ordinary (isCredit: false) item's base price prints with no minus and no muted styling", async () => {
    const ordinaryItem = baseDocSheetItem({
      code: "X-5180",
      unitPrice: "175000.00",
      total: "175000.00",
      isCredit: false,
      lines: [],
    });
    const html = await renderQuotationHtml(baseQuotationData({ items: [ordinaryItem] }));
    const summaryStart = html.indexOf('class="pq-section pq-summary-section"');
    const summaryHtml = html.slice(summaryStart);

    expect(summaryHtml).toContain("$175,000");
    expect(summaryHtml).not.toContain("-$175,000");
    // The embedded <style> block always defines .pq-negative regardless (same
    // caveat as the credit-item test above) -- assert on the actual class
    // *attribute* an element would carry, not the bare class name.
    expect(summaryHtml).not.toContain('class="pq-col-amount pq-amount pq-negative"');
    expect(summaryHtml).not.toContain('class="pq-col-qty pq-negative"');
  });

  it("hides the per-item subtotal row when price display is off, even with options", async () => {
    const html = await renderQuotationHtml(
      baseQuotationData({
        showItemPrices: false,
        showOptionPrices: false,
        items: [
          baseDocSheetItem({
            code: "X-5180",
            lines: [{ id: "line-1", code: "MTS", name: "MTS", description: null, qty: 1, unitPrice: "40425.00", lineTotal: "40425.00", image: null }],
          }),
        ],
      })
    );
    expect(html).not.toContain('class="pq-item-subtotal-row"');
  });

  it("used to ignore the price-display flags entirely — now renders no item money when both are off, while the document grand total still shows", async () => {
    const html = await renderQuotationHtml(
      baseQuotationData({
        showItemPrices: false,
        showOptionPrices: false,
        items: [
          baseDocSheetItem({
            code: "X-5180",
            unitPrice: "175000.00",
            total: "215425.00",
            lines: [{ id: "line-1", code: "MTS", name: "MTS", description: null, qty: 1, unitPrice: "40425.00", lineTotal: "40425.00", image: null }],
          }),
        ],
      })
    );
    expect(html).not.toContain("$175,000");
    expect(html).not.toContain("$215,425");
    expect(html).not.toContain("$40,425");
    expect(html).not.toContain('class="pq-item-subtotal-row"');
    // The grand total is still shown regardless of the item-level flags —
    // those only gate the itemized per-item detail.
    expect(html).toContain("1,100");
  });

  it("still shows the per-item subtotal when option prices are hidden but item prices are on", async () => {
    // showOptionPrices off (each option's own `lineTotal` in the breakdown
    // is null, exactly what `toSheetData` would produce — see
    // `buildItemBreakdown`), but showItemPrices on — the owner's rule: a
    // salesperson can hide the option-level detail and still show an
    // honest per-machine subtotal figure.
    const html = await renderQuotationHtml(
      baseQuotationData({
        showItemPrices: true,
        showOptionPrices: false,
        items: [
          baseDocSheetItem({
            code: "X-5180",
            unitPrice: "175000.00",
            total: "215425.00",
            lines: [{ id: "line-1", code: "MTS", name: "MTS", description: null, qty: 1, unitPrice: "40425.00", lineTotal: "40425.00", image: null }],
            breakdown: {
              qty: 1,
              basePrice: "175000.00",
              basePriceUnquoted: false,
              assembledFromOptions: false,
              options: [{ name: "MTS", code: "MTS", description: null, qty: 1, lineTotal: null }],
              discount: null,
              subtotal: "215425.00",
            },
          }),
        ],
      })
    );
    expect(html).toContain('class="pq-item-subtotal-row"');
    expect(html).toContain("X-5180 subtotal");
    expect(html).toContain("$215,425");
    // The option's own price never appears — only its name/qty do.
    expect(html).not.toContain("$40,425");
  });

  // The other half of the fix that hides the equipment-detail base row: the
  // Investment Summary shows the same machine at the same price, so if it
  // still printed "$0" the two pages would contradict each other.
  describe("a product with no price of its own", () => {
    const unpricedItem = (lines: QuotationData["items"][number]["lines"]) =>
      baseDocSheetItem({
        code: "SERVICE",
        name: "Service",
        unitPrice: "0.00",
        total: lines.length > 0 ? "1,200.00" : "0.00",
        lines,
        breakdown: buildItemBreakdown(
          {
            unitPrice: "0.00",
            listPrice: "0.00",
            discountMode: "PERCENT",
            discountValue: null,
            discountAmount: "0.00",
            total: lines.length > 0 ? "1200.00" : "0.00",
            lines,
            isCredit: false,
          },
          true
        ),
      });

    it("prints no money against it when it has no options either", async () => {
      const html = await renderQuotationHtml(
        baseQuotationData({ showItemPrices: true, items: [unpricedItem([])] })
      );
      // The row survives — dropping it would leave the item with nothing at
      // all — but nothing in it reads as "this machine costs zero dollars".
      expect(html).toContain("SERVICE");
      expect(html).not.toContain(">$0<");
    });

    it("drops its row when its options carry the price", async () => {
      const modules = [
        {
          id: "line-1",
          code: "SVC-EL-INSTALL",
          name: "EasyLoader installation",
          description: null,
          qty: 1,
          unitPrice: "1200.00",
          lineTotal: "1200.00",
          image: null,
        },
      ];
      const html = await renderQuotationHtml(
        baseQuotationData({ showItemPrices: true, items: [unpricedItem(modules)] })
      );
      expect(html).toContain("EasyLoader installation");
      expect(html).not.toContain(">$0<");
    });

    it("still prints the $0 a salesperson typed by hand", async () => {
      // The catalogue prices this machine; the zero is a giveaway someone
      // decided on, and that figure is the message.
      const html = await renderQuotationHtml(
        baseQuotationData({
          showItemPrices: true,
          items: [
            baseDocSheetItem({
              unitPrice: "0.00",
              total: "0.00",
              breakdown: buildItemBreakdown(
                {
                  unitPrice: "0.00",
                  listPrice: "175000.00",
                  discountMode: "PERCENT",
                  discountValue: null,
                  discountAmount: "0.00",
                  total: "0.00",
                  lines: [],
                  isCredit: false,
                },
                true
              ),
            }),
          ],
        })
      );
      expect(html).toContain(">$0<");
    });
  });

  it("renders the totals block (Subtotal/Tax/TOTAL) after the items table, at the bottom of the summary section", async () => {
    const data = baseQuotationData({ items: [baseDocSheetItem()] });
    const html = await renderQuotationHtml(data);

    const summaryStart = html.indexOf('class="pq-section pq-summary-section"');
    const itemsTableIdx = html.indexOf('class="pq-items"', summaryStart);
    const totalsIdx = html.indexOf('class="pq-totals"', summaryStart);
    const totalRowIdx = html.indexOf("TOTAL</span>", summaryStart);

    expect(summaryStart).toBeGreaterThan(-1);
    // Items table comes before the totals block, which comes before the
    // TOTAL row itself — Subtotal/Discount/Tax/TOTAL all render at the
    // bottom of the summary section, under the item+option rows, not above
    // them. The page-level "Total investment" banner (asserted separately)
    // is a different element entirely and stays at the very top of the page.
    expect(itemsTableIdx).toBeGreaterThan(-1);
    expect(totalsIdx).toBeGreaterThan(itemsTableIdx);
    expect(totalRowIdx).toBeGreaterThan(totalsIdx);
  });

  it("still shows the page-level Total investment banner above Equipment Detail, unaffected by the toggles", async () => {
    const data = baseQuotationData({
      machineSections: [
        {
          itemId: "item-1",
          sectionTitle: "Item",
          titleBlockHtml: null,
          specSentence: null,
          sectionPrice: null,
          hasInlinePrice: false,
          baseRow: { code: "M5180", name: "M Series 5180", qty: 1, price: null },
          optionRows: [],
          lineSummary: baseDocSheetItem(),
        },
      ],
    });
    const html = await renderQuotationHtml(data);
    const bannerIdx = html.indexOf("Total investment");
    const equipmentIdx = html.indexOf("Equipment Detail");
    expect(bannerIdx).toBeGreaterThan(-1);
    expect(bannerIdx).toBeLessThan(equipmentIdx);
  });
});

describe("renderQuotationHtml — the machine heads its own options table", () => {
  const withBaseRow = (price: string | null, showOptionPrices: boolean) =>
    baseQuotationData({
      showOptionPrices,
      machineSections: [
        {
          itemId: "item-1",
          sectionTitle: "Item",
          titleBlockHtml: null,
          specSentence: null,
          sectionPrice: null,
          hasInlinePrice: false,
          baseRow: { code: "X-10180", name: "Pathfinder X-10180 Cutting System", qty: 1, price },
          optionRows: [
            {
              id: "line-1",
              icon: null,
              code: "AFP",
              name: "Automatic Foot Pressure",
              descriptionHtml: null,
              attributesLine: null,
              qty: 1,
              price: showOptionPrices ? "$1,560.00" : null,
            },
          ],
          lineSummary: baseDocSheetItem(),
        },
      ],
    });

  it("prints the machine as the first row, above its options", async () => {
    const html = await renderQuotationHtml(withBaseRow("$212,500.00", true));
    const machineIdx = html.indexOf("Pathfinder X-10180 Cutting System");
    const optionIdx = html.indexOf("Automatic Foot Pressure");
    expect(machineIdx).toBeGreaterThan(-1);
    expect(optionIdx).toBeGreaterThan(machineIdx);
    expect(html).toContain("$212,500.00");
  });

  it("hides the machine's price with the option prices, not separately", async () => {
    const html = await renderQuotationHtml(withBaseRow(null, false));
    // The row itself still renders — the customer sees what they are buying,
    // just not what each piece costs.
    expect(html).toContain("Pathfinder X-10180 Cutting System");
    expect(html).not.toContain("$212,500.00");
  });

  it("keeps an unpriced row for a machine that has no price of its own", async () => {
    // Service: no options to carry the price, so the row has to stay or the
    // item vanishes — but with prices on and nothing to print in the price
    // column, which is the whole complaint about "$0".
    const html = await renderQuotationHtml(withBaseRow(null, true));
    expect(html).toContain("Pathfinder X-10180 Cutting System");
    expect(html).toContain('class="pq-option-row pq-base-row"');
    // Its option still prints its own price — only the machine's row is bare.
    expect(html).toContain("$1,560.00");
  });

  it("drops the row entirely when the options carry the whole price", async () => {
    // An EasyLoader: the modules below say everything the base row would.
    const data = withBaseRow(null, true);
    const html = await renderQuotationHtml({
      ...data,
      machineSections: [{ ...data.machineSections[0], baseRow: null }],
    });
    expect(html).not.toContain("Pathfinder X-10180 Cutting System");
    expect(html).not.toContain('class="pq-option-row pq-base-row"');
    // The table is still there, headed by the options that do carry the price.
    expect(html).toContain("Automatic Foot Pressure");
  });
});

describe("renderQuotationHtml — Notes section placement", () => {
  it("renders Notes after Equipment Detail and before Investment Summary", async () => {
    const data = baseQuotationData({
      notesHtml: "<p>Freeform remarks.</p>",
      machineSections: [
        {
          itemId: "item-1",
          sectionTitle: "Item",
          titleBlockHtml: null,
          specSentence: null,
          sectionPrice: null,
          hasInlinePrice: false,
          baseRow: { code: "M5180", name: "M Series 5180", qty: 1, price: null },
          optionRows: [],
          lineSummary: baseDocSheetItem(),
        },
      ],
    });
    const html = await renderQuotationHtml(data);
    const equipmentIdx = html.indexOf("Equipment Detail");
    const notesIdx = html.indexOf("Freeform remarks.");
    const summaryIdx = html.indexOf("Investment Summary");
    expect(equipmentIdx).toBeGreaterThan(-1);
    expect(notesIdx).toBeGreaterThan(equipmentIdx);
    expect(summaryIdx).toBeGreaterThan(notesIdx);
  });

  it("renders no Notes section at all when notesHtml is null", async () => {
    const html = await renderQuotationHtml(baseQuotationData({ notesHtml: null }));
    expect(html).not.toContain(">Notes<");
  });
});

describe("renderQuotationHtml — Ex Works delivery terms", () => {
  it("prints the terms in the total-investment banner and the totals block instead of a GST rate, and never a '0%' tax line", async () => {
    const html = await renderQuotationHtml(
      baseQuotationData({
        totals: {
          currency: "AUD",
          subtotal: "1000.00",
          discountMode: "PERCENT",
          discountValue: null,
          discountAmount: "0.00",
          taxName: "GST",
          taxRate: "10",
          // Already zeroed by recalcDocument (src/lib/actions/documents.ts)
          // for an EX_WORKS document.
          taxAmount: "0.00",
          total: "1000.00",
          deliveryTerms: "EX_WORKS",
        },
      })
    );
    expect(html).toContain("Ex Works — no GST applicable");
    expect(html).not.toContain("GST 0%");
    expect(html).not.toContain("GST 10%");
    expect(html).not.toContain("(incl. GST 10%)");
  });

  it("still prints the ordinary tax-rate line when DELIVERED — unchanged from before this feature", async () => {
    const html = await renderQuotationHtml(baseQuotationData());
    expect(html).toContain("incl. GST 10%");
    expect(html).not.toContain("Ex Works");
  });
});

// Commit 1: "if you don't set a discount, it doesn't appear in the letter,
// that's good. But if you explicitly set 0, it says the discount is 0. This
// gives the client room to negotiate." — an explicit `0` must read exactly
// like no discount at all, at both the document level and the item level.
describe("renderQuotationHtml — an explicit zero discount must not print", () => {
  it("prints no document-level Discount row for an explicit 0%, but does for a real discount", async () => {
    const zeroHtml = await renderQuotationHtml(
      baseQuotationData({
        totals: {
          currency: "AUD",
          subtotal: "1000.00",
          discountMode: "PERCENT",
          discountValue: "0",
          discountAmount: "0.00",
          taxName: "GST",
          taxRate: "10",
          taxAmount: "100.00",
          total: "1100.00",
          deliveryTerms: "DELIVERED",
        },
      })
    );
    expect(zeroHtml).not.toContain("Discount 0%");
    expect(zeroHtml).not.toMatch(/Discount \d/);

    const realHtml = await renderQuotationHtml(
      baseQuotationData({
        totals: {
          currency: "AUD",
          subtotal: "1000.00",
          discountMode: "PERCENT",
          discountValue: "10",
          discountAmount: "100.00",
          taxName: "GST",
          taxRate: "10",
          taxAmount: "90.00",
          total: "990.00",
          deliveryTerms: "DELIVERED",
        },
      })
    );
    expect(realHtml).toContain("Discount 10%");
  });

  it("prints no item-level discount row for an explicit 0%, but does for a real discount", async () => {
    const zeroHtml = await renderQuotationHtml(
      baseQuotationData({
        items: [
          baseDocSheetItem({
            unitPrice: "1000.00",
            discountMode: "PERCENT",
            discountValue: "0",
            total: "1000.00",
          }),
        ],
      })
    );
    // The stylesheet embedded in every render always defines the
    // `.pq-discount-row` CSS rule (static CSS, present whether or not any
    // element uses the class) — so the assertion has to look for the class
    // actually applied to an element, not just the bare class name
    // appearing anywhere in the document.
    expect(zeroHtml).not.toContain('class="pq-discount-row"');

    const realHtml = await renderQuotationHtml(
      baseQuotationData({
        items: [
          baseDocSheetItem({
            unitPrice: "1000.00",
            discountMode: "PERCENT",
            discountValue: "15",
            total: "850.00",
          }),
        ],
      })
    );
    expect(realHtml).toContain('class="pq-discount-row"');
  });
});

// The commission a salesperson earns is internal-only (see CommissionResult's
// doc comment, src/lib/pricing.ts) — it must never reach a customer-facing
// render. `QuotationData` (this file's own `baseQuotationData`) has no
// `commission` field at all, so the pipeline can't leak it by construction —
// but that's exactly the property a careless future change (e.g. spreading
// `document` straight into `QuotationData`, or copy-pasting the builder's
// `DocumentTotals` block into a sheet component) could quietly break. This
// test reproduces the owner's own corrected worked example end to end — a
// real document that DOES earn a real, non-trivial commission ($1,944, at
// the pricing-engine level — see the "reproduces the owner's corrected
// worked example" test in tests/pricing.test.ts) — and asserts that figure,
// and the word "commission" itself, never appear anywhere in the rendered
// quotation HTML.
describe("renderQuotationHtml — commission never appears in the rendered quotation", () => {
  it("does not render the owner's worked-example commission figure ($1,944) or the word 'commission'", async () => {
    // Same document as the owner's corrected example: 5 items (10,000 /
    // 15,000 / 20,000 / 3,000 commissionable, 6,000 no-commission), a 10%
    // document discount that reaches only the 48,000 commissionable total
    // (Commit 1) -> the customer pays $49,200, and (at the pricing-engine
    // level, verified separately) a $1,944 commission.
    const engineResult = computeTotals({
      items: [
        { unitPrice: 10000, lines: [] },
        { unitPrice: 15000, lines: [] },
        { unitPrice: 20000, lines: [] },
        { unitPrice: 3000, lines: [] },
        { unitPrice: 6000, lines: [], isNoCommission: true },
      ],
      extraLines: [],
      documentDiscountMode: "PERCENT",
      documentDiscountValue: "10",
      taxRate: 0,
      commissionTiers: DEFAULT_COMMISSION_TIERS,
    });
    // Confirms this test is actually exercising the $1,944 scenario it
    // claims to, not a stale/wrong fixture.
    expect(engineResult.taxableBase).toBe(49200);
    expect(engineResult.commission).toEqual({ base: "43200.00", ratePct: 4.5, amount: "1944.00" });

    const html = await renderQuotationHtml(
      baseQuotationData({
        items: [
          baseDocSheetItem({ code: "ITEM-1", unitPrice: "10000.00", total: "10000.00" }),
          baseDocSheetItem({ code: "ITEM-2", unitPrice: "15000.00", total: "15000.00" }),
          baseDocSheetItem({ code: "ITEM-3", unitPrice: "20000.00", total: "20000.00" }),
          baseDocSheetItem({ code: "ITEM-4", unitPrice: "3000.00", total: "3000.00" }),
          baseDocSheetItem({ code: "ITEM-5", unitPrice: "6000.00", total: "6000.00" }),
        ],
        totals: {
          currency: "AUD",
          subtotal: "54000.00",
          discountMode: "PERCENT",
          discountValue: "10",
          discountAmount: "4800.00",
          taxName: "GST",
          taxRate: "0",
          taxAmount: "0.00",
          total: "49200.00",
          deliveryTerms: "DELIVERED",
        },
      })
    );

    // Sanity check: this really is the $49,200 document the commission was
    // computed against, not an unrelated fixture that trivially passes.
    expect(html).toContain("49,200");

    expect(html).not.toContain("1,944");
    expect(html).not.toContain("1944");
    expect(html.toLowerCase()).not.toContain("commission");
  });

  it("never mentions 'commission' on an ordinary quotation either", async () => {
    const html = await renderQuotationHtml(baseQuotationData({ items: [baseDocSheetItem()] }));
    expect(html.toLowerCase()).not.toContain("commission");
  });
});
