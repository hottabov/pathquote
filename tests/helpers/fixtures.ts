// Document-shaped fixtures shared by the test files that exercise the pure
// mappers: sheet-data, quotation-data, catalog-visibility and the
// production-form pipeline. Each builder takes an overrides object and
// returns a fresh, fully-populated value — no module-level object is ever
// handed out, so one test can never see another's mutation even with
// vitest's `isolate: false` sharing a module registry across files.
//
// Only builders with more than one consumer live here. A fixture used by a
// single file stays in that file, where its defaults sit next to the
// assertions that depend on them; moving those here would trade locality for
// nothing. The defaults below are the ones the original per-file copies
// carried, so the assertions that read them are unchanged.
//
// Imports are limited to the same dependency-free modules the mappers
// themselves allow (no `@/lib/db`, no `next/*`), so importing this helper
// never makes a test need `DATABASE_URL`.
import type {
  ToSheetCompanyInput,
  ToSheetDataDoc,
  ToSheetItemInput,
} from "../../src/lib/sheet-data";
import type { QuotationDataDoc, QuotationItemInput } from "../../src/lib/quotation-data";
import type { FormContext, FormItem } from "../../src/lib/production-forms/types";

/** A client company with no delivery address of its own — the plain case;
 * tests that care about delivery pass `hasDeliveryAddress: true` plus the
 * delivery* fields they are actually asserting on. */
export function sheetCompany(overrides: Partial<ToSheetCompanyInput> = {}): ToSheetCompanyInput {
  return {
    name: "Acme Pty Ltd",
    street: null,
    city: null,
    state: null,
    postcode: null,
    country: null,
    website: null,
    hasDeliveryAddress: false,
    deliveryStreet: null,
    deliveryCity: null,
    deliveryState: null,
    deliveryPostcode: null,
    deliveryCountry: null,
    deliveryContactName: null,
    deliveryPhone: null,
    ...overrides,
  };
}

/** A single undiscounted $1,000 line item with no options attached. The
 * money fields are deliberately self-consistent (`unitPrice` = `listPrice` =
 * `total`, zero discount) so a test that overrides one of them and forgets
 * the others gets an obviously wrong number rather than a plausible one. */
export function sheetItem(overrides: Partial<ToSheetItemInput> = {}): ToSheetItemInput {
  return {
    id: "item-1",
    code: "EL-2020",
    name: "EasyLoader 2020",
    description: null,
    unitPrice: "1000.00",
    listPrice: "1000.00",
    discountMode: "PERCENT",
    discountValue: null,
    discountAmount: "0.00",
    total: "1000.00",
    imageUrl: null,
    showImage: false,
    lines: [],
    isCredit: false,
    ...overrides,
  };
}

/** A DRAFT document with no client, no items and live (un-snapshotted)
 * entity fields, priced to match a single `sheetItem()` should a test add
 * one. The entity values are deliberately labelled "Live ..." so a test that
 * passes an `entitySnapshot` can assert which of the two sources won. */
export function sheetDoc(overrides: Partial<ToSheetDataDoc> = {}): ToSheetDataDoc {
  return {
    status: "DRAFT",
    number: null,
    issueDate: new Date("2026-08-30T00:00:00.000Z"),
    validityDays: null,
    defaultValidityDays: 7,
    currency: "AUD",
    taxName: "GST",
    taxRate: "10",
    deliveryTerms: "DELIVERED",
    entitySnapshot: null,
    entityName: "Live Region Entity",
    entityLegalId: "ABN 111",
    entityAddress: "1 Live St",
    bankDetails: { bank: "Live Bank", bsb: "000 000", accountNo: "111 111" },
    logoUrl: null,
    footerText: "Live footer",
    discountMode: "PERCENT",
    discountValue: null,
    subtotal: "1000.00",
    discountAmount: "0.00",
    taxAmount: "100.00",
    total: "1100.00",
    company: null,
    contact: null,
    items: [],
    extraLines: [],
    author: { name: "Jane Author", email: "jane@example.com", phone: null, avatar: null },
    notes: null,
    showItemPrices: true,
    showOptionPrices: true,
    heroImageUrl: null,
    ...overrides,
  };
}

/** An M-Series machine: `sheetItem`'s shape plus the three fields the
 * quotation renderer needs (`serialNumber`, `seriesCode`, `specs`). The
 * stored `specs` deliberately agree with what the code "M5180" parses to,
 * so a test proving code-parsing wins over stored specs has to set them to
 * something different on purpose. */
export function quotationItem(overrides: Partial<QuotationItemInput> = {}): QuotationItemInput {
  return {
    ...sheetItem({
      code: "M5180",
      name: "M5180 Cutting System",
      unitPrice: "175000.00",
      listPrice: "175000.00",
      total: "175000.00",
    }),
    serialNumber: null,
    seriesCode: "M",
    specs: { cutHeightCm: 18, cutWidthCm: 180 },
    lines: [],
    ...overrides,
  };
}

/** A one-machine AU quotation with both price-display toggles off (the
 * quotation-first default — see `setPriceDisplay`), which is what makes the
 * `{{price}}`-hiding tests meaningful. */
export function quotationDoc(overrides: Partial<QuotationDataDoc> = {}): QuotationDataDoc {
  return {
    ...sheetDoc({
      validityDays: 30,
      entityName: "Pathfinder Australia Pty Ltd",
      entityLegalId: "ABN 64 072 458 667",
      entityAddress: "12 Did Ct, Tullamarine Vic. 3043, Australia",
      bankDetails: { bank: "ANZ Westfield", bsb: "013 442", accountNo: "4405 63886" },
      footerText: null,
      subtotal: "175000.00",
      taxAmount: "17500.00",
      total: "192500.00",
      author: {
        name: "Jane Author",
        email: "jane@example.com",
        phone: "0400 000 000",
        avatar: null,
      },
    }),
    regionId: "region-au",
    items: [quotationItem()],
    showItemPrices: false,
    showOptionPrices: false,
    ...overrides,
  };
}

/** One M5220 line on a production form, with no options selected. */
export function formItem(overrides: Partial<FormItem> = {}): FormItem {
  return {
    id: "item1",
    code: "M5220",
    name: "M-Series",
    spec: { ui: "+Y", knifeSize: "1.5x5.0", drills: { required: false, detail: "" } },
    optionCodes: [],
    optionAttributes: {},
    optionQtys: [],
    ...overrides,
  };
}

/** The context a production form is rendered from: who is selling, to whom,
 * and which single item this form covers. */
export function formContext(overrides: Partial<FormContext> = {}): FormContext {
  return {
    distributorName: "Pathfinder Australia Pty Ltd",
    authorName: "Vadym H",
    company: { name: "Relaxvanguard", addressLines: ["12 Industrial Dr"], industry: "Automotive" },
    contact: { fullName: "John Smith", position: "Manager", phone: "+61", email: "j@example.com" },
    deliveryAddressLines: ["12 Industrial Dr"],
    softwareCodes: [],
    item: formItem(),
    ...overrides,
  };
}
