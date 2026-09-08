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
import type { OptionRole } from "@prisma/client";
import type { FormContext, FormItem, FormItemOption } from "../../src/lib/production-forms/types";
import { legacyOptionViews } from "../../src/lib/production-forms/context";

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
    currencySymbol: null,
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

/** An M-Series machine: `sheetItem`'s shape plus the fields the quotation
 * renderer needs (`serialNumber`, `kind`, `seriesName`, `seriesId`, `specs`,
 * `seriesQuoteDescription`). The `specs` deliberately disagree with the code
 * "M5180" (18cm, not 5cm) so a test can tell the column apart from the
 * label: the renderer reads the column.
 *
 * `seriesQuoteDescription` defaults to `null` — the state every category
 * starts in — so a test that cares about the copy printed under the heading
 * passes its own body in, and one that doesn't gets a section with no copy
 * rather than inheriting a shared template it never read. */
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
    kind: "MACHINE",
    seriesName: "M-Series",
    // A real `Series.id` is a cuid; any stable non-null string does here —
    // what matters is that the draft banner has something to link to, and
    // that a test can override it to `null` to exercise the unresolved-
    // category path.
    seriesId: "series-m",
    specs: { cutHeightCm: 18, cutWidthCm: 180 },
    seriesQuoteDescription: null,
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
    /** The region's own standard-terms figures — the `Region` column defaults
     * from schema.prisma, so a test that overrides one of the four on the
     * quote itself can assert which of the two sources won (the same trick
     * `sheetDoc`'s "Live ..." entity strings play against `entitySnapshot`). */
    region: { deliveryWeeks: 14, installationDays: 2, trainingDays: 3, warrantyMonths: 12 },
    deliveryWeeks: null,
    installationDays: null,
    trainingDays: null,
    warrantyMonths: null,
    excludedDocumentKeys: [],
    documentsSnapshot: null,
    items: [quotationItem()],
    showItemPrices: false,
    showOptionPrices: false,
    signatures: [],
    ...overrides,
  };
}

/** One option line on a form item, qty 1 and no attributes unless given. */
export function formOption(
  code: string,
  role: OptionRole | null,
  overrides: Partial<Omit<FormItemOption, "code" | "role">> = {}
): FormItemOption {
  return { id: `opt-${code}`, code, role, qty: 1, attributes: null, ...overrides };
}

/** One M5220 line on a production form, with no options selected. The legacy
 * code views (`optionCodes` etc.) are derived from `options` unless a test
 * overrides them explicitly, so the two can never disagree by accident. */
export function formItem(overrides: Partial<FormItem> = {}): FormItem {
  const options = overrides.options ?? [];
  return {
    id: "item1",
    code: "M5220",
    name: "M-Series",
    kind: "MACHINE",
    form: "M_SERIES",
    specs: { cutHeightCm: 5, cutWidthCm: 227, widthCode: 220, modelTier: "M5" },
    spec: { ui: "+Y", knifeSize: "1.5x5.0", drills: { required: false, detail: "" } },
    options,
    ...legacyOptionViews(options),
    ...overrides,
  };
}

/** The context a production form is rendered from: who is selling, to whom,
 * and which single item this form covers. `softwareCodes` follows
 * `software` unless overridden, same as the item's option views. */
export function formContext(overrides: Partial<FormContext> = {}): FormContext {
  const software = overrides.software ?? [];
  return {
    distributorName: "Pathfinder Australia Pty Ltd",
    authorName: "Vadym H",
    company: { name: "Relaxvanguard", addressLines: ["12 Industrial Dr"], industry: "Automotive" },
    contact: { fullName: "John Smith", position: "Manager", phone: "+61", email: "j@example.com" },
    deliveryAddressLines: ["12 Industrial Dr"],
    software,
    softwareCodes: software.map((s) => s.code),
    item: formItem(),
    ...overrides,
  };
}
