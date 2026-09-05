import { describe, it, expect } from "vitest";
import {
  buildItemBreakdown,
  dedupeDescription,
  formatBankDetails,
  toSheetData,
} from "../src/lib/sheet-data";
import { formatMoney } from "../src/lib/format";
import { sheetCompany, sheetDoc, sheetItem } from "./helpers/fixtures";

// Pure mapper — this file imports nothing from src/lib/queries/documents.ts
// or @/lib/db (see sheet-data.ts's header comment for why), so it never
// needs DATABASE_URL set, same as tests/finalize-validation.test.ts. The
// document/item builders live in ./helpers/fixtures because the quotation
// and catalog-visibility tests need the same ones.

describe("toSheetData — FINAL vs DRAFT entity source", () => {
  it("uses live region fields for a DRAFT (no entitySnapshot yet)", () => {
    const doc = sheetDoc({ status: "DRAFT", entitySnapshot: null });
    const sheet = toSheetData(doc);

    expect(sheet.isDraft).toBe(true);
    expect(sheet.entity.name).toBe("Live Region Entity");
    expect(sheet.entity.legalId).toBe("ABN 111");
    expect(sheet.entity.address).toBe("1 Live St");
    expect(sheet.entity.footerText).toBe("Live footer");
  });

  it("prefers the frozen entitySnapshot over live region fields for a FINAL document", () => {
    const doc = sheetDoc({
      status: "FINAL",
      number: "Q-AU-2026-001",
      // Deliberately different from the "live" entityName/entityAddress/etc.
      // above — if the mapper ever regressed to reading the live fields for
      // a FINAL doc, these assertions would catch it immediately.
      entitySnapshot: {
        entityName: "Frozen Snapshot Entity",
        entityLegalId: "ABN 999",
        entityAddress: "9 Frozen Ave",
        bankDetails: { bank: "Frozen Bank" },
        logoUrl: "/api/files/frozen-logo.png",
        footerText: "Frozen footer",
      },
    });
    const sheet = toSheetData(doc);

    expect(sheet.isDraft).toBe(false);
    expect(sheet.entity.name).toBe("Frozen Snapshot Entity");
    expect(sheet.entity.legalId).toBe("ABN 999");
    expect(sheet.entity.address).toBe("9 Frozen Ave");
    expect(sheet.entity.footerText).toBe("Frozen footer");
    expect(sheet.entity.bankDetails).toEqual([{ label: "Bank", value: "Frozen Bank" }]);
    expect(sheet.logo).toBe("/api/files/frozen-logo.png");
  });

  it("falls back to live region fields when a FINAL document's entitySnapshot is malformed", () => {
    // Defensive case: `entitySnapshot` is an opaque Json column with no
    // compile-time shape guarantee — a hand-edited or corrupted row must
    // never crash the renderer.
    const doc = sheetDoc({ status: "FINAL", number: "Q-AU-2026-002", entitySnapshot: { garbage: true } });
    const sheet = toSheetData(doc);

    expect(sheet.entity.name).toBe("Live Region Entity");
  });

  it("ignores entitySnapshot for a DRAFT even if one is somehow present", () => {
    const doc = sheetDoc({
      status: "DRAFT",
      entitySnapshot: { entityName: "Should Be Ignored", entityLegalId: null, entityAddress: null, bankDetails: null, logoUrl: null, footerText: null },
    });
    const sheet = toSheetData(doc);

    expect(sheet.entity.name).toBe("Live Region Entity");
  });
});

describe("toSheetData — validity date", () => {
  it("falls back to the org default validityDays for a quote with none of its own set (not yet finalized)", () => {
    const doc = sheetDoc({
      validityDays: null,
      defaultValidityDays: 7,
      issueDate: new Date("2026-08-30T00:00:00.000Z"),
    });
    expect(toSheetData(doc).validityDate).toBe("06/09/2026");
  });

  it("is issueDate + validityDays, formatted DD/MM/YYYY, for a finalized quote", () => {
    const doc = sheetDoc({
      status: "FINAL",
      number: "Q-AU-2026-001",
      issueDate: new Date("2026-08-30T00:00:00.000Z"),
      validityDays: 7,
    });
    const sheet = toSheetData(doc);

    expect(sheet.issueDate).toBe("30/08/2026");
    expect(sheet.validityDate).toBe("06/09/2026");
  });

  it("titles every document QUOTATION", () => {
    const data = toSheetData(sheetDoc());
    expect(data.title).toBe("QUOTATION");
  });

  it("always shows the signature block", () => {
    const data = toSheetData(sheetDoc());
    expect(data.showSignature).toBe(true);
  });
});

describe("toSheetData — client block", () => {
  it("is null when the document has no company yet", () => {
    expect(toSheetData(sheetDoc({ company: null })).client).toBeNull();
  });

  it("builds address lines from the company's separate street/city/state/postcode/country fields", () => {
    const doc = sheetDoc({
      company: sheetCompany({
        name: "Acme Pty Ltd",
        street: "1 Example Rd",
        city: "Tullamarine",
        state: "VIC",
        postcode: "3043",
        country: "AU",
        website: "acme.example",
      }),
      contact: { firstName: "Jane", lastName: "Doe", email: "jane@example.com", phone: "0400 000 000" },
    });
    const sheet = toSheetData(doc);

    expect(sheet.client).not.toBeNull();
    expect(sheet.client?.companyName).toBe("Acme Pty Ltd");
    expect(sheet.client?.addressLines).toEqual(["1 Example Rd", "Tullamarine, VIC, 3043", "Australia"]);
    expect(sheet.client?.website).toBe("acme.example");
    expect(sheet.client?.contactName).toBe("Jane Doe");
    expect(sheet.client?.contactEmail).toBe("jane@example.com");
    expect(sheet.client?.contactPhone).toBe("0400 000 000");
  });

  it("renders a legacy free-text country verbatim when it can't be normalized", () => {
    const doc = sheetDoc({
      company: sheetCompany({ street: "1 Example Rd", country: "Narnia" }),
    });
    expect(toSheetData(doc).client?.addressLines).toEqual(["1 Example Rd", "Narnia"]);
  });

  it("omits missing address fields instead of rendering empty lines", () => {
    const doc = sheetDoc({
      company: sheetCompany({ name: "No Address Co" }),
    });
    expect(toSheetData(doc).client?.addressLines).toEqual([]);
  });
});

describe("toSheetData — delivery address block", () => {
  it("is null when the document has no company yet", () => {
    expect(toSheetData(sheetDoc({ company: null })).delivery).toBeNull();
  });

  it("is null when the company has no distinct delivery address", () => {
    const doc = sheetDoc({ company: sheetCompany({ hasDeliveryAddress: false }) });
    expect(toSheetData(doc).delivery).toBeNull();
  });

  it("builds the delivery block from the company's delivery* fields, with country displayed by name", () => {
    const doc = sheetDoc({
      company: sheetCompany({
        hasDeliveryAddress: true,
        deliveryStreet: "2 Factory Rd",
        deliveryCity: "Melbourne",
        deliveryState: "VIC",
        deliveryPostcode: "3000",
        deliveryCountry: "AU",
        deliveryContactName: "Sam Rivera",
        deliveryPhone: "+61393383471",
      }),
    });
    const sheet = toSheetData(doc);

    expect(sheet.delivery).not.toBeNull();
    expect(sheet.delivery?.addressLines).toEqual(["2 Factory Rd", "Melbourne, VIC, 3000", "Australia"]);
    expect(sheet.delivery?.contactName).toBe("Sam Rivera");
    expect(sheet.delivery?.phone).toBe("+61393383471");
  });
});

describe("toSheetData — items and lines", () => {
  it("carries the item discount mode and value through untouched, null when unset", () => {
    const withDiscount = toSheetData(
      sheetDoc({ items: [sheetItem({ discountMode: "PERCENT", discountValue: "15" })] })
    );
    expect(withDiscount.items[0].discountMode).toBe("PERCENT");
    expect(withDiscount.items[0].discountValue).toBe("15");

    const withAmount = toSheetData(
      sheetDoc({ items: [sheetItem({ discountMode: "AMOUNT", discountValue: "20000.00" })] })
    );
    expect(withAmount.items[0].discountMode).toBe("AMOUNT");
    expect(withAmount.items[0].discountValue).toBe("20000.00");

    const withoutDiscount = toSheetData(sheetDoc({ items: [sheetItem({ discountValue: null })] }));
    expect(withoutDiscount.items[0].discountValue).toBeNull();
  });

  // Commit 1: an explicit `0` discount must not print — same rule as the
  // document-level discount row (see quotation-sheet.tsx). `discountValue`
  // itself still passes through untouched (asserted above — the raw stored
  // value is not the thing being hidden), but `breakdown.discount` — what
  // both the customer-facing sheet and the builder's ItemBreakdownEditor
  // actually render off — must read `null` for an explicit zero exactly as
  // it does for "no discount set at all".
  it("an explicit 0 item discount renders no breakdown.discount row; a real discount still does", () => {
    const explicitZero = toSheetData(
      sheetDoc({ items: [sheetItem({ discountMode: "PERCENT", discountValue: "0", discountAmount: "0.00" })] })
    );
    expect(explicitZero.items[0].breakdown.discount).toBeNull();

    const explicitZeroAmount = toSheetData(
      sheetDoc({ items: [sheetItem({ discountMode: "AMOUNT", discountValue: "0.00", discountAmount: "0.00" })] })
    );
    expect(explicitZeroAmount.items[0].breakdown.discount).toBeNull();

    const noDiscountAtAll = toSheetData(sheetDoc({ items: [sheetItem({ discountValue: null })] }));
    expect(noDiscountAtAll.items[0].breakdown.discount).toBeNull();

    const realDiscount = toSheetData(
      sheetDoc({ items: [sheetItem({ discountMode: "PERCENT", discountValue: "15", discountAmount: "150.00" })] })
    );
    expect(realDiscount.items[0].breakdown.discount).toEqual({ mode: "PERCENT", value: "15", amount: "150.00" });
  });

  it("computes each option line's lineTotal as qty * unitPrice", () => {
    const doc = sheetDoc({
      items: [
        sheetItem({
          lines: [
            { id: "line-1", code: "OPT-1", name: "Extra shelf", description: null, qty: 3, unitPrice: "25.50" },
          ],
        }),
      ],
    });
    const sheet = toSheetData(doc);
    expect(sheet.items[0].lines[0].lineTotal).toBe("76.50");
  });

  it("computes extra (document-level) line totals the same way", () => {
    const doc = sheetDoc({
      extraLines: [{ id: "extra-1", code: null, name: "Delivery", description: null, qty: 2, unitPrice: "50" }],
    });
    expect(toSheetData(doc).extraLines[0].lineTotal).toBe("100.00");
  });

  it("only shows an item image when showImage is true AND an imageUrl is present", () => {
    const noFlag = toSheetData(sheetDoc({ items: [sheetItem({ showImage: false, imageUrl: "/api/files/a.jpg" })] }));
    expect(noFlag.items[0].image).toBeNull();

    const noUrl = toSheetData(sheetDoc({ items: [sheetItem({ showImage: true, imageUrl: null })] }));
    expect(noUrl.items[0].image).toBeNull();

    const both = toSheetData(sheetDoc({ items: [sheetItem({ showImage: true, imageUrl: "/api/files/a.jpg" })] }));
    expect(both.items[0].image).toBe("/api/files/a.jpg");
  });

  it("runs a shown image through the caller-supplied resolver", () => {
    const doc = sheetDoc({ items: [sheetItem({ showImage: true, imageUrl: "/api/files/a.jpg" })] });
    const sheet = toSheetData(doc, (url) => `data:image/jpeg;base64,RESOLVED(${url})`);
    expect(sheet.items[0].image).toBe("data:image/jpeg;base64,RESOLVED(/api/files/a.jpg)");
  });

  it("hides the image when the resolver declines to produce one", () => {
    const doc = sheetDoc({ items: [sheetItem({ showImage: true, imageUrl: "/api/files/missing.jpg" })] });
    const sheet = toSheetData(doc, () => undefined);
    expect(sheet.items[0].image).toBeNull();
  });

  it("only shows an extra line's image when showImage is true AND an imageUrl is present", () => {
    const noFlag = toSheetData(
      sheetDoc({
        extraLines: [
          { id: "extra-1", code: null, name: "Trade-in", description: null, qty: 1, unitPrice: "-500", showImage: false, imageUrl: "/api/files/a.jpg" },
        ],
      })
    );
    expect(noFlag.extraLines[0].image).toBeNull();

    const noUrl = toSheetData(
      sheetDoc({
        extraLines: [
          { id: "extra-1", code: null, name: "Trade-in", description: null, qty: 1, unitPrice: "-500", showImage: true, imageUrl: null },
        ],
      })
    );
    expect(noUrl.extraLines[0].image).toBeNull();

    const both = toSheetData(
      sheetDoc({
        extraLines: [
          { id: "extra-1", code: null, name: "Trade-in", description: null, qty: 1, unitPrice: "-500", showImage: true, imageUrl: "/api/files/a.jpg" },
        ],
      })
    );
    expect(both.extraLines[0].image).toBe("/api/files/a.jpg");
  });
});

describe("toSheetData — a $0 manual price prints, it is not swallowed as absent", () => {
  // John: "if I give it away for zero dollars... I give them back zero
  // dollars" — the customer has to be able to see they did not pay for it,
  // which means a $0 line must render "$0", never nothing.
  it("carries a $0 item price through to unitPrice/total exactly, not null or omitted", () => {
    const sheet = toSheetData(sheetDoc({ items: [sheetItem({ unitPrice: "0.00", total: "0.00" })] }));
    const item = sheet.items[0];
    expect(item.unitPrice).toBe("0.00");
    expect(item.total).toBe("0.00");
    expect(item.breakdown.basePrice).toBe("0.00");
    expect(item.breakdown.subtotal).toBe("0.00");
  });

  it("formats a $0 item total as the literal string \"$0\" (formatMoney is never gated by truthiness of the amount)", () => {
    const sheet = toSheetData(sheetDoc({ items: [sheetItem({ unitPrice: "0.00", total: "0.00" })] }));
    const item = sheet.items[0];
    // Every renderer (document-sheet.tsx, quotation-sheet.tsx,
    // items-list.tsx) gates a price on an explicit boolean/null check
    // (showPrices, itemPriceVisible, lineTotal !== null) — never on the
    // amount's own truthiness — so this must print "$0", not an empty cell.
    expect(formatMoney(item.total, sheet.totals.currency)).toBe("$0");
    expect(formatMoney(item.breakdown.basePrice, sheet.totals.currency)).toBe("$0");
  });

  it("formats a $0 option line the same way", () => {
    const sheet = toSheetData(
      sheetDoc({
        items: [
          sheetItem({
            lines: [{ id: "line-1", code: "OPT-1", name: "Free upgrade", description: null, qty: 1, unitPrice: "0.00" }],
          }),
        ],
      })
    );
    const line = sheet.items[0].lines[0];
    expect(line.lineTotal).toBe("0.00");
    expect(formatMoney(line.lineTotal, sheet.totals.currency)).toBe("$0");
  });

  it("buildItemBreakdown never treats a $0 basePrice/option lineTotal as absent (null)", () => {
    const breakdown = buildItemBreakdown(
      sheetItem({
        unitPrice: "0.00",
        total: "0.00",
        lines: [{ id: "line-1", code: "OPT-1", name: "Free upgrade", description: null, qty: 1, unitPrice: "0.00" }],
      }),
      true // showOptionPrices
    );
    expect(breakdown.basePrice).toBe("0.00");
    expect(breakdown.basePrice).not.toBeNull();
    expect(breakdown.options[0].lineTotal).toBe("0.00");
    expect(breakdown.options[0].lineTotal).not.toBeNull();
  });

  it("buildItemBreakdown negates basePrice (and option lineTotal) for a credit item -- unitPrice is stored/typed positive", () => {
    const breakdown = buildItemBreakdown(
      sheetItem({
        unitPrice: "20000.00",
        total: "-20000.00", // already signed by the pricing engine
        isCredit: true,
        lines: [{ id: "line-1", code: null, name: "Extra", description: null, qty: 1, unitPrice: "500.00" }],
      }),
      true // showOptionPrices
    );
    expect(breakdown.basePrice).toBe("-20000.00");
    expect(breakdown.options[0].lineTotal).toBe("-500.00");
    // subtotal is a passthrough of the already-signed engine total, never
    // recomputed here.
    expect(breakdown.subtotal).toBe("-20000.00");
  });

  it("buildItemBreakdown leaves an ordinary (isCredit: false) item's basePrice positive", () => {
    const breakdown = buildItemBreakdown(sheetItem({ unitPrice: "20000.00", isCredit: false }), true);
    expect(breakdown.basePrice).toBe("20000.00");
  });
});

describe("dedupeDescription", () => {
  it("passes null straight through", () => {
    expect(dedupeDescription("EasyLoader 2020", null)).toBeNull();
  });

  it("drops a description that exactly equals the name", () => {
    expect(dedupeDescription("EasyLoader 2020", "EasyLoader 2020")).toBeNull();
  });

  it("drops a description that is a substring of the name", () => {
    expect(dedupeDescription("EasyLoader 2020 Heavy Duty Winch", "EasyLoader 2020")).toBeNull();
  });

  it("drops a name that is a substring of the description", () => {
    expect(dedupeDescription("EasyLoader 2020", "EasyLoader 2020 Heavy Duty Winch")).toBeNull();
  });

  it("keeps a description that is genuinely distinct from the name", () => {
    expect(dedupeDescription("EasyLoader 2020", "Ships with mounting bracket")).toBe(
      "Ships with mounting bracket"
    );
  });
});

describe("toSheetData — item/line description dedupe", () => {
  it("omits the item description when it duplicates the item name", () => {
    const doc = sheetDoc({ items: [sheetItem({ name: "EasyLoader 2020", description: "EasyLoader 2020" })] });
    expect(toSheetData(doc).items[0].description).toBeNull();
  });

  it("keeps a genuinely distinct item description", () => {
    const doc = sheetDoc({
      items: [sheetItem({ name: "EasyLoader 2020", description: "Ships with mounting bracket" })],
    });
    expect(toSheetData(doc).items[0].description).toBe("Ships with mounting bracket");
  });

  it("omits an option line description when it duplicates the line name", () => {
    const doc = sheetDoc({
      items: [
        sheetItem({
          lines: [
            { id: "line-1", code: "OPT-1", name: "Extra shelf", description: "Extra shelf", qty: 1, unitPrice: "25" },
          ],
        }),
      ],
    });
    expect(toSheetData(doc).items[0].lines[0].description).toBeNull();
  });
});

describe("toSheetData — totals passthrough", () => {
  it("passes the document totals straight through", () => {
    const doc = sheetDoc({
      subtotal: "1000.00",
      discountMode: "PERCENT",
      discountValue: "10",
      discountAmount: "100.00",
      taxAmount: "90.00",
      total: "990.00",
      currency: "USD",
      taxName: "Sales Tax",
      taxRate: "0",
    });
    const sheet = toSheetData(doc);
    expect(sheet.totals).toEqual({
      currency: "USD",
      subtotal: "1000.00",
      discountMode: "PERCENT",
      discountValue: "10",
      discountAmount: "100.00",
      taxName: "Sales Tax",
      taxRate: "0",
      taxAmount: "90.00",
      total: "990.00",
      deliveryTerms: "DELIVERED",
    });
  });

  it("carries deliveryTerms straight through, DELIVERED or EX_WORKS", () => {
    expect(toSheetData(sheetDoc({ deliveryTerms: "DELIVERED" })).totals.deliveryTerms).toBe("DELIVERED");
    expect(toSheetData(sheetDoc({ deliveryTerms: "EX_WORKS" })).totals.deliveryTerms).toBe("EX_WORKS");
  });
});

describe("toSheetData — preparedBy / notes", () => {
  it("maps the document author straight through to preparedBy", () => {
    const doc = sheetDoc({
      author: { name: "Jane Author", email: "jane@example.com", phone: "0400 000 000", avatar: null },
    });
    const sheet = toSheetData(doc);
    expect(sheet.preparedBy).toEqual({
      name: "Jane Author",
      email: "jane@example.com",
      phone: "0400 000 000",
      avatar: null,
    });
  });

  it("carries a null author name/phone through untouched", () => {
    const doc = sheetDoc({ author: { name: null, email: "noname@example.com", phone: null, avatar: null } });
    const sheet = toSheetData(doc);
    expect(sheet.preparedBy).toEqual({ name: null, email: "noname@example.com", phone: null, avatar: null });
  });

  it("resolves the author's avatar through resolveImage, like the logo", () => {
    const doc = sheetDoc({
      author: { name: "Jane Author", email: "jane@example.com", phone: null, avatar: "/api/files/a.jpg" },
    });
    const sheet = toSheetData(doc, (url) => `data:image/jpeg;base64,RESOLVED(${url})`);
    expect(sheet.preparedBy.avatar).toBe("data:image/jpeg;base64,RESOLVED(/api/files/a.jpg)");
  });

  it("renders no avatar when the author has none", () => {
    const doc = sheetDoc({ author: { name: "Jane Author", email: "jane@example.com", phone: null, avatar: null } });
    const sheet = toSheetData(doc);
    expect(sheet.preparedBy.avatar).toBeNull();
  });

  it("resolves the document's hero image through resolveImage, like the logo and the avatar", () => {
    const doc = sheetDoc({ heroImageUrl: "/api/files/setup.jpg" });
    const sheet = toSheetData(doc, (url) => `data:image/jpeg;base64,RESOLVED(${url})`);
    expect(sheet.heroImage).toBe("data:image/jpeg;base64,RESOLVED(/api/files/setup.jpg)");
  });

  it("renders no hero image when the document has none", () => {
    const doc = sheetDoc({ heroImageUrl: null });
    const sheet = toSheetData(doc);
    expect(sheet.heroImage).toBeNull();
  });

  it("passes notes through untouched, null when unset", () => {
    expect(toSheetData(sheetDoc({ notes: "Freeform remarks" })).notes).toBe("Freeform remarks");
    expect(toSheetData(sheetDoc({ notes: null })).notes).toBeNull();
  });
});

describe("toSheetData — validityDate default fallback", () => {
  it("uses the org default when validityDays is null", () => {
    const doc = sheetDoc({
      status: "DRAFT",
      validityDays: null,
      defaultValidityDays: 7,
      issueDate: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(toSheetData(doc).validityDate).toBe("08/01/2026");
  });

  it("uses the document's own validityDays when set, ignoring the default", () => {
    const doc = sheetDoc({
      status: "DRAFT",
      validityDays: 30,
      defaultValidityDays: 7,
      issueDate: new Date("2026-01-01T00:00:00.000Z"),
    });
    expect(toSheetData(doc).validityDate).toBe("31/01/2026");
  });

  it("the two produce different dates for the same issueDate", () => {
    const withDefault = toSheetData(
      sheetDoc({ validityDays: null, defaultValidityDays: 7, issueDate: new Date("2026-01-01T00:00:00.000Z") })
    ).validityDate;
    const withOwnValue = toSheetData(
      sheetDoc({ validityDays: 30, defaultValidityDays: 7, issueDate: new Date("2026-01-01T00:00:00.000Z") })
    ).validityDate;
    expect(withDefault).not.toBe(withOwnValue);
  });
});

describe("formatBankDetails", () => {
  it("joins each row as 'Label: value', one per line, in order", () => {
    const text = formatBankDetails([
      { label: "Bank", value: "ANZ Westfield" },
      { label: "BSB", value: "013 442" },
      { label: "Account No.", value: "4405 63886" },
    ]);
    expect(text).toBe("Bank: ANZ Westfield\nBSB: 013 442\nAccount No.: 4405 63886");
  });

  it("returns an empty string for no rows", () => {
    expect(formatBankDetails([])).toBe("");
  });

  it("shares the same label mapping toSheetData uses for entity.bankDetails", () => {
    const doc = sheetDoc({ bankDetails: { bank: "Live Bank", bsb: "000 000", accountNo: "111 111" } });
    const sheet = toSheetData(doc);
    expect(formatBankDetails(sheet.entity.bankDetails)).toBe("Bank: Live Bank\nBSB: 000 000\nAccount No.: 111 111");
  });
});


// --- was tests/item-breakdown.test.ts: toSheetData — item.breakdown ------------------

describe("toSheetData — item.breakdown", () => {
  it("carries the base price separately from the subtotal", () => {
    const doc = sheetDoc({
      items: [
        sheetItem({
          unitPrice: "175000.00",
          total: "186000.00",
          lines: [
            {
              id: "line-1",
              code: "OPT-1",
              name: "Winch upgrade",
              description: null,
              qty: 1,
              unitPrice: "11000.00",
            },
          ],
        }),
      ],
    });
    const sheet = toSheetData(doc);
    const breakdown = sheet.items[0].breakdown;

    expect(breakdown.basePrice).toBe("175000.00");
    expect(breakdown.subtotal).toBe("186000.00");
  });

  it("negates a credit item's base price to match its already-negative total (isCredit: true)", () => {
    const doc = sheetDoc({
      items: [
        sheetItem({
          code: "TRADE-IN",
          unitPrice: "20000.00", // typed positive, per Product.isCredit's design
          total: "-20000.00", // already signed by the pricing engine (see getDocumentForBuilder)
          isCredit: true,
        }),
      ],
    });
    const breakdown = toSheetData(doc).items[0].breakdown;
    expect(breakdown.basePrice).toBe("-20000.00");
    expect(breakdown.subtotal).toBe("-20000.00");
  });

  it("always reports qty 1 for a product line", () => {
    const doc = sheetDoc({ items: [sheetItem()] });
    expect(toSheetData(doc).items[0].breakdown.qty).toBe(1);
  });

  it("nulls every option's lineTotal when option prices are hidden, but keeps the subtotal", () => {
    const doc = sheetDoc({
      showOptionPrices: false,
      items: [
        sheetItem({
          unitPrice: "175000.00",
          total: "186000.00",
          lines: [
            {
              id: "line-1",
              code: "OPT-1",
              name: "Winch upgrade",
              description: null,
              qty: 1,
              unitPrice: "11000.00",
            },
            {
              id: "line-2",
              code: "OPT-2",
              name: "Extra shelf",
              description: null,
              qty: 3,
              unitPrice: "25.50",
            },
          ],
        }),
      ],
    });
    const breakdown = toSheetData(doc).items[0].breakdown;

    expect(breakdown.options).toHaveLength(2);
    expect(breakdown.options.every((option) => option.lineTotal === null)).toBe(true);
    expect(breakdown.subtotal).toBe("186000.00");
  });

  it("resolves a fixed (AMOUNT) discount to its cash figure", () => {
    const doc = sheetDoc({
      items: [
        sheetItem({
          discountMode: "AMOUNT",
          discountValue: "6000.00",
          discountAmount: "6000.00",
        }),
      ],
    });
    const breakdown = toSheetData(doc).items[0].breakdown;

    expect(breakdown.discount).toEqual({ mode: "AMOUNT", value: "6000.00", amount: "6000.00" });
  });

  it("reports both the typed percentage and the resolved cash amount for a PERCENT discount", () => {
    const doc = sheetDoc({
      items: [
        sheetItem({
          unitPrice: "1000.00",
          discountMode: "PERCENT",
          discountValue: "10",
          discountAmount: "100.00",
          total: "900.00",
        }),
      ],
    });
    const breakdown = toSheetData(doc).items[0].breakdown;

    expect(breakdown.discount).toEqual({ mode: "PERCENT", value: "10", amount: "100.00" });
  });

  it("reports no discount when the item has none set", () => {
    const doc = sheetDoc({ items: [sheetItem({ discountValue: null })] });
    expect(toSheetData(doc).items[0].breakdown.discount).toBeNull();
  });

  it("carries each option's own code and (deduped) description through, same as an item's own", () => {
    const doc = sheetDoc({
      items: [
        sheetItem({
          lines: [
            {
              id: "line-1",
              code: "OPT-1",
              name: "Winch upgrade",
              description: "Heavy-duty electric winch, 2000kg capacity",
              qty: 1,
              unitPrice: "11000.00",
            },
            {
              id: "line-2",
              code: "OPT-2",
              name: "Extra shelf",
              description: "Extra shelf", // redundant with name — deduped to null
              qty: 1,
              unitPrice: "25.50",
            },
            {
              id: "line-3",
              code: null,
              name: "No-code option",
              description: null,
              qty: 1,
              unitPrice: "10.00",
            },
          ],
        }),
      ],
    });
    const options = toSheetData(doc).items[0].breakdown.options;

    expect(options[0]).toMatchObject({
      code: "OPT-1",
      description: "Heavy-duty electric winch, 2000kg capacity",
    });
    expect(options[1]).toMatchObject({ code: "OPT-2", description: null });
    expect(options[2]).toMatchObject({ code: null, description: null });
  });

  // An EasyLoader has no price of its own -- it is a table assembled from
  // 1.2m modules, every one of which is an option. Neither has Service. No
  // money prints against such a product's own row, because "$0" reads as
  // though the machine were being given away; and when the options carry the
  // whole price, the row goes too, since it then says nothing the heading
  // above it has not already said.
  describe("basePriceUnquoted / assembledFromOptions", () => {
    const modules = [
      { id: "line-1", code: "EL-2020 Drive Module (first 1.2M)", name: "Drive Module", description: null, qty: 1, unitPrice: "4050.00" },
      { id: "line-2", code: "EL-2020 Additional 1.2M lengths", name: "Additional 1.2M", description: null, qty: 4, unitPrice: "1200.00" },
    ];

    const breakdownOf = (item: Parameters<typeof sheetItem>[0]) =>
      toSheetData(sheetDoc({ items: [sheetItem(item)] })).items[0].breakdown;

    it("drops the row for an assembled product carrying options", () => {
      const breakdown = breakdownOf({
        unitPrice: "0.00",
        listPrice: "0.00",
        lines: modules,
        total: "8850.00",
      });
      expect(breakdown.basePriceUnquoted).toBe(true);
      expect(breakdown.assembledFromOptions).toBe(true);
    });

    it("keeps an unpriced row for an assembled product with no options at all", () => {
      // Service, the case the options-present rule used to miss entirely:
      // there are no option rows to carry the price, so dropping this row
      // would leave the item with nothing at all -- but printing "$0" against
      // it is what made the owner think the whole line was free.
      const breakdown = breakdownOf({ unitPrice: "0.00", listPrice: "0.00", lines: [], total: "0.00" });
      expect(breakdown.basePriceUnquoted).toBe(true);
      expect(breakdown.assembledFromOptions).toBe(false);
    });

    it("keeps the row and the price for a machine a salesperson hand-zeroed", () => {
      // The catalogue still prices it, so the $0 is a decision someone made
      // and the row is where the customer reads it.
      const breakdown = breakdownOf({
        unitPrice: "0.00",
        listPrice: "175000.00",
        lines: modules,
        total: "8850.00",
      });
      expect(breakdown.basePriceUnquoted).toBe(false);
      expect(breakdown.assembledFromOptions).toBe(false);
    });

    it("keeps the price for a catalogue-unpriced machine priced by hand", () => {
      // An import gap (`Price.needsReview`) snapshots into `listPrice` as 0,
      // exactly like a deliberate zero. What separates them is that real money
      // is being charged here, and it has to print.
      const breakdown = breakdownOf({
        unitPrice: "85000.00",
        listPrice: "0.00",
        lines: modules,
        total: "93850.00",
      });
      expect(breakdown.basePriceUnquoted).toBe(false);
      expect(breakdown.assembledFromOptions).toBe(false);
    });

    it("is NOT set for an ordinary priced machine", () => {
      const breakdown = breakdownOf({ lines: modules });
      expect(breakdown.basePriceUnquoted).toBe(false);
      expect(breakdown.assembledFromOptions).toBe(false);
    });

    it("is NOT set when the list price was never recorded", () => {
      // A row from before the column existed. Unknown is not zero.
      const breakdown = breakdownOf({
        unitPrice: "0.00",
        listPrice: null,
        lines: modules,
        total: "8850.00",
      });
      expect(breakdown.basePriceUnquoted).toBe(false);
      expect(breakdown.assembledFromOptions).toBe(false);
    });
  });
});
