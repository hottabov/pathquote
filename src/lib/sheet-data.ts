// Pure mapper from a loaded document (as `getDocumentForBuilder` returns it,
// or anything structurally compatible) to `DocSheetData` — the flat,
// JSON-serializable shape the quotation renderer builds on. NOT specific to
// the old plain "Summary" sheet (removed — the quotation is the only
// customer-facing rendering now): `buildQuotationData` in
// src/lib/quotation-data.ts calls `toSheetData` below for everything the
// quotation shares with what the summary used to (entity/client header,
// investment-summary items+totals), so this module stays even though its
// former other consumer is gone. Deliberately has zero `@/lib/db` or
// `next/*` imports (same reasoning as src/lib/validation/finalize.ts: a
// plain `vitest run` of this file must never need `DATABASE_URL` set) — its
// only dependencies are the equally dependency-free pricing engine and
// date/money formatters. The input type below is defined from scratch
// rather than imported from src/lib/queries/documents.ts so this module can
// never accidentally pull in that file's `@/lib/db` import — TypeScript's
// structural typing means the real `DocumentForBuilder` satisfies
// `ToSheetDataDoc` without either file importing the other.
//
// The FINAL-vs-DRAFT split lives entirely here: a FINAL document's entity
// identity (name/legal id/address/bank details/footer) comes from its frozen
// `entitySnapshot` so a later edit to the region never retroactively changes
// an already-issued document; a DRAFT (which has no snapshot yet) falls back
// to the region's live values. `currency`/`taxName`/`taxRate` are never
// entity-snapshot-dependent — they're set once on the `Document` row itself
// at creation (see `createDraft` in src/lib/actions/documents.ts) and never
// change afterwards, for both DRAFT and FINAL.
import { fromCents, toCents } from "./pricing";
import { formatDateAU } from "./format";
import { displayCountry } from "./countries";
import { identityResolver } from "./sheet-identity";

// --- input shape -------------------------------------------------------------

export type ToSheetLineInput = {
  id: string;
  code: string | null;
  name: string;
  description: string | null;
  qty: number;
  unitPrice: string;
  /** `BuilderLine.imageUrl`/`showImage` — see that type's doc comment.
   * Optional (unlike `ToSheetItemInput`'s always-present pair) so existing
   * fixtures/tests that construct a line without them still type-check;
   * `toDocSheetLine` treats a missing `showImage` the same as `false`. Only
   * a CUSTOM (extra) line's own photo ever renders through this — an
   * OPTION's catalog image is resolved into the same field but
   * `showImage` is never set true for one, so it never actually displays
   * here (see `DocSheetLine.image`). */
  imageUrl?: string | null;
  showImage?: boolean;
};

export type ToSheetItemInput = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  unitPrice: string;
  /** `DocumentItem.listPrice` — the catalogue price snapshotted when this
   * item was added, which is not always what is being charged (a manual
   * price edit moves `unitPrice` and leaves this alone). Read here for one
   * question only, and always together with `unitPrice`: whether the product
   * has a price of its own at all. See `ItemBreakdown.basePriceUnquoted`.
   * Null on a row added before the column existed. */
  listPrice: string | null;
  discountMode: "PERCENT" | "AMOUNT";
  discountValue: string | null;
  /** The item discount resolved to a cash amount (0.00 when unset) — same
   * money the pricing engine already subtracted from base+options to reach
   * `total` below (`PricingTotals.itemDiscounts`, see `getDocumentForBuilder`),
   * carried through as its own field so `ItemBreakdown.discount.amount`
   * never has to re-derive it (money arithmetic stays in pricing.ts, not
   * here — see `buildItemBreakdown`). */
  discountAmount: string;
  /** Pre-computed by the pricing engine (see `getDocumentForBuilder`) —
   * this mapper never re-derives money math, only reshapes it. */
  total: string;
  imageUrl: string | null;
  showImage: boolean;
  lines: ToSheetLineInput[];
  /** `Product.isCredit` (the item's product — see that column's doc comment
   * in schema.prisma) — `false` for an ordinary item. Read by
   * `buildItemBreakdown` to negate `ItemBreakdown.basePrice`/`options[].lineTotal`
   * for a credit item, so the sheet prints the same minus sign the pricing
   * engine already applied to `total` (`ToSheetItemInput.total`, via
   * `EngineItem.isCredit` — see src/lib/pricing.ts) — without this, the
   * item's own base-price row would show a positive figure while its
   * subtotal row showed a negative one. */
  isCredit: boolean;
};

export type ToSheetCompanyInput = {
  name: string;
  street: string | null;
  city: string | null;
  state: string | null;
  postcode: string | null;
  country: string | null;
  website: string | null;
  /** Whether this company actually has a delivery address distinct from
   * the main one above — resolved server-side (see `BuilderCompany` in
   * src/lib/queries/documents.ts) as `!deliverySameAsMain` plus "at least
   * one delivery field is actually filled in", so a company that merely
   * has the flag unset but no delivery data never renders an empty block. */
  hasDeliveryAddress: boolean;
  deliveryStreet: string | null;
  deliveryCity: string | null;
  deliveryState: string | null;
  deliveryPostcode: string | null;
  deliveryCountry: string | null;
  deliveryContactName: string | null;
  deliveryPhone: string | null;
};

export type ToSheetContactInput = {
  firstName: string;
  lastName: string | null;
  email: string | null;
  phone: string | null;
};

/** The document's author (`Document.author`), as much as the "Prepared by"
 * block needs (owner reference doc: "Prepared by: <manager name / phone>,
 * <email>") — `email` is always set (required on `User`), `name`/`phone`
 * are both optional profile fields an admin may not have filled in. */
export type ToSheetAuthorInput = {
  name: string | null;
  email: string;
  phone: string | null;
  /** `User.image` — NextAuth's own profile-picture column, reused as the
   * author's avatar (see src/lib/queries/documents.ts's `author` field for
   * the fuller reuse note). A stored `/api/files/<name>` URL, or `null`
   * when the author has none — `toSheetData` resolves it through
   * `resolveImage` exactly like `logoUrl`/item images below, never passes
   * it through unresolved. */
  avatar: string | null;
};

/** The minimal shape `toSheetData` needs. `entitySnapshot`/`bankDetails` are
 * `unknown` because they're opaque Prisma `Json` columns with no
 * compile-time guarantee about their contents — this module validates their
 * shape defensively at runtime (see `parseEntitySnapshot`) rather than
 * trusting the cast. */
export type ToSheetDataDoc = {
  status: "DRAFT" | "FINAL";
  number: string | null;
  issueDate: Date;
  validityDays: number | null;
  /** The org-wide default validity, in days, already resolved (see
   * `getDocumentForBuilder`'s `defaultValidityDays` for how) — `toSheetData`
   * falls back to this whenever `validityDays` above is `null`, so a draft
   * that has never had its own validity set still shows a "Valid until"
   * date (the one the manager would get if they finalized right now)
   * instead of none at all. Never written back onto `validityDays` itself. */
  defaultValidityDays: number;
  currency: string;
  taxName: string;
  taxRate: string;
  /** DELIVERED (the default) or EX_WORKS — see the `DeliveryTerms` enum in
   * schema.prisma. An EX_WORKS document's `taxAmount`/`total` below are
   * already zero-tax (resolved once, at `recalcDocument`, src/lib/actions/
   * documents.ts — the single source of truth for a document's effective
   * tax rate); this field exists purely so `toSheetData` can swap the
   * printed tax-rate line for the terms themselves (see `DocSheetTotals`) —
   * an EX_WORKS quote must read as deliberate ("Ex Works — no GST
   * applicable"), not as a forgotten "GST 0%" line. */
  deliveryTerms: "DELIVERED" | "EX_WORKS";
  entitySnapshot: unknown;
  entityName: string;
  entityLegalId: string | null;
  entityAddress: string | null;
  bankDetails: unknown;
  logoUrl: string | null;
  footerText: string | null;
  discountMode: "PERCENT" | "AMOUNT";
  discountValue: string | null;
  subtotal: string;
  discountAmount: string;
  taxAmount: string;
  total: string;
  company: ToSheetCompanyInput | null;
  contact: ToSheetContactInput | null;
  items: ToSheetItemInput[];
  extraLines: ToSheetLineInput[];
  /** The document's author — feeds the "Prepared by" block (see
   * `DocSheetPreparedBy`). Always present: `Document.authorId` is a required
   * field. */
  author: ToSheetAuthorInput;
  /** `Document.notes` exactly as stored — free-text, admin-authored rich
   * text (HTML from the WYSIWYG editor, or legacy markdown for a
   * pre-migration row — see src/lib/rich-text.ts's `isHtmlContent`),
   * rendered by the quotation sheet via `renderStoredRichText`
   * (src/lib/quotation-data.ts's `notesHtml` — see its doc comment on why
   * the rendering happens there rather than in this dependency-light
   * mapper). `null` when the author hasn't written any. */
  notes: string | null;
  /** Quotation-first pricing display toggles (see `setPriceDisplay` in
   * src/lib/actions/documents.ts) — carried through so `toSheetData` can
   * gate `DocSheetItem.breakdown.options[].lineTotal` (hidden whenever
   * `showOptionPrices` is off) without the presenter component ever having
   * to know about either flag itself (see `ItemBreakdown`'s doc comment).
   * Also surfaced on `DocSheetData` so `QuotationSheet` can compute its own
   * `itemPriceVisible = showItemPrices || showOptionPrices`. */
  showItemPrices: boolean;
  showOptionPrices: boolean;
  /** `Document.heroImageUrl` — the quotation's setup image (see that
   * column's doc comment in schema.prisma), unresolved: a stored
   * `/api/files/<name>` URL, or `null` when none has been uploaded.
   * `toSheetData` resolves it through `resolveImage` into `DocSheetData.heroImage`
   * exactly like `logoUrl`/the author's avatar. */
  heroImageUrl: string | null;
};

/** Resolves a stored image URL (e.g. `/api/files/<uuid>.jpg`) to whatever
 * the caller wants actually embedded in the sheet — the in-app preview
 * route passes an identity function (the URL is fine as-is, the browser is
 * already authenticated), while the future PDF pipeline passes a function
 * that reads the file off disk and returns a base64 data URI (Gotenberg's
 * headless Chromium can't hit an auth-gated `/api/files/...` URL). Returning
 * `undefined` hides the image entirely (e.g. a missing file). Synchronous by
 * design so `toSheetData` itself stays a plain, pure function — an async
 * resolver would force every caller (including this module's own tests)
 * to await a mapper that has no other reason to be async. */
export type ImageResolver = (url: string) => string | undefined;

// --- output shape --------------------------------------------------------

export type DocSheetLine = {
  id: string;
  code: string | null;
  name: string;
  description: string | null;
  qty: number;
  unitPrice: string;
  lineTotal: string;
  /** Resolved thumbnail source, or `null` when either `showImage` is false,
   * no image was ever attached, or the resolver declined to produce one —
   * same gating as `DocSheetItem.image`. In practice only ever set for a
   * document-level extra line with its own attached photo (a trade-in, a
   * bought-in item); an item's own OPTION sub-lines never have `showImage`
   * set. */
  image: string | null;
};

/**
 * The three-part idea every product-line renderer needs — base price, then
 * options, then a subtotal — expressed once so `quotation-sheet.tsx` and
 * `builder/item-breakdown-editor.tsx` render it through one shared shape
 * (the former via `src/components/sheet/item-breakdown.tsx`) instead of
 * each deciding for itself how to show the money (the bug this type fixes:
 * a renderer used to print only the combined `total`, leaving the base
 * machine price invisible to the customer).
 */
export type ItemBreakdown = {
  /** Always `1` today — a product line is always one machine; more machines
   * means more lines (confirmed by the owner). Rendered as-is, never
   * multiplied against anything. */
  qty: number;
  /** The machine on its own, with no options folded in — a plain 2dp decimal
   * string ready for `formatMoney`. */
  basePrice: string;
  /**
   * The product has no price of its own to quote: the catalogue prices it at
   * nothing, and nothing is being charged for it either. The EasyLoader is
   * the case this exists for — a table assembled from 1.2 metre modules,
   * where the machine line is genuinely free and every part of it is priced
   * as an option — but Service is the same shape without the modules, and so
   * is any product whose whole price lives somewhere other than its own row.
   *
   * Renderers print no money against the base row when this is set. A reader
   * who sees "$0" against a machine reasonably concludes the table is free or
   * that something is broken; a blank says the honest thing, which is that
   * this row is not where the price is.
   *
   * The catalogue price is half the test, and that half is the whole point. A
   * machine a salesperson hand-zeroed as a giveaway keeps its "$0", because
   * there the figure *is* the message. The charged price is the other half:
   * a machine the catalogue never priced (an import gap — see `Price.needsReview`)
   * but that a salesperson then priced by hand is being sold for real money,
   * and that money must print. Only when both are nothing is there nothing to
   * say.
   */
  basePriceUnquoted: boolean;
  /**
   * `basePriceUnquoted` and the item's price is carried entirely by option
   * rows that follow it, so the base row is dropped altogether rather than
   * merely left blank: the item's name and description are already printed in
   * the caller's own header row above it, and a nameless, priceless row under
   * that heading is a duplicate of it.
   *
   * Requires options to be present, and that is the difference between this
   * and `basePriceUnquoted`. An assembled product with none is a half-built
   * machine; dropping its row too would leave the item with no rows at all,
   * concealing the unfinished machine instead of showing it. It keeps a row —
   * an unpriced one.
   */
  assembledFromOptions: boolean;
  options: Array<{
    name: string;
    /** The option's own catalog code (e.g. "MTS"), or `null` when it has
     * none — rendered ahead of `name` as "`code` — `name`", same as an
     * item's own `code` alongside its name. Carried through unchanged from
     * `ToSheetLineInput.code` (see `buildItemBreakdown`). */
    code: string | null;
    /** Deduped against `name` the same way `DocSheetLine.description` is
     * (see `dedupeDescription`) — `null` when the option has no
     * description of its own, or when it would just repeat `name`. */
    description: string | null;
    qty: number;
    /** `null` when option prices are hidden (`showOptionPrices` off) — the
     * presenter renders no price for the row in that case rather than
     * needing to know about the display flag itself. */
    lineTotal: string | null;
  }>;
  /** `null` when the item has no discount set. `value` is what the
   * salesperson typed (a bare percentage like "5", or a cash figure like
   * "20000.00"); `amount` is the cash actually deducted, always resolved
   * regardless of `mode` — see `ToSheetItemInput.discountAmount`. */
  discount: { mode: "PERCENT" | "AMOUNT"; value: string; amount: string } | null;
  /** base + options − discount — the pricing engine's own item total
   * (`ToSheetItemInput.total`), never recomputed here. */
  subtotal: string;
};

export type DocSheetItem = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  unitPrice: string;
  /** How to read `discountValue` below — see `DocSheetTotals.discountMode`'s
   * doc comment; same rule at item level. */
  discountMode: "PERCENT" | "AMOUNT";
  /** Percentage string (e.g. "10") when `discountMode` is "PERCENT", a plain
   * decimal cash string (e.g. "20000.00") when "AMOUNT", or `null` when no
   * item discount is set — the sheet only renders an "Item discount" row
   * when this is non-null, formatting it per `discountMode`. */
  discountValue: string | null;
  total: string;
  /** Resolved thumbnail source, or `null` when either `showImage` is false,
   * no image was ever attached, or the resolver declined to produce one. */
  image: string | null;
  lines: DocSheetLine[];
  /** The base/options/discount/subtotal breakdown for this item — see
   * `ItemBreakdown`. */
  breakdown: ItemBreakdown;
};

export type BankDetailRow = { label: string; value: string };

export type DocSheetEntity = {
  name: string;
  legalId: string | null;
  address: string | null;
  bankDetails: BankDetailRow[];
  footerText: string | null;
};

export type DocSheetClient = {
  companyName: string;
  addressLines: string[];
  website: string | null;
  contactName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
};

/** The company's delivery address (owner: "client office is not always the
 * manufacturing site") — only ever set when it's genuinely distinct from
 * the main address above (see `ToSheetCompanyInput.hasDeliveryAddress`), so
 * `DocSheetData.delivery` doubles as the sheet's render gate. */
export type DocSheetDelivery = {
  addressLines: string[];
  contactName: string | null;
  phone: string | null;
};

/** Resolved "Prepared by" block — same shape as `ToSheetAuthorInput`, kept
 * as a distinct output type (rather than reusing the input type directly)
 * so a future mapper-side transform (e.g. a display fallback) has somewhere
 * to live without touching the input contract. Today it's a straight
 * passthrough — see `toSheetData`. */
export type DocSheetPreparedBy = {
  name: string | null;
  email: string;
  phone: string | null;
  /** Resolved thumbnail source (already run through `resolveImage` — see
   * `ImageResolver`), or `null` when the author has no avatar. `null` here
   * means "print no image" — an initials circle is a UI affordance for
   * screens with no photo, not something that belongs on a customer-facing
   * quote (see `quotation-sheet.tsx`, which never falls back to initials
   * for this field). */
  avatar: string | null;
};

export type DocSheetTotals = {
  currency: string;
  subtotal: string;
  /** Whether `discountValue` (below) is a percentage or a cash amount —
   * the sheet's "Discount" row label reads accordingly ("Discount 5%" vs.
   * "Discount $20,000.00"). `discountAmount` (the actual cents subtracted
   * from `subtotal`) is unaffected by this — it's already resolved to cash
   * by the pricing engine regardless of how the discount was entered. */
  discountMode: "PERCENT" | "AMOUNT";
  discountValue: string | null;
  discountAmount: string;
  taxName: string;
  taxRate: string;
  taxAmount: string;
  total: string;
  /** See `ToSheetDataDoc.deliveryTerms` — carried through so
   * `quotation-sheet.tsx` can print "Ex Works — no GST applicable" in place
   * of a `{taxName} 0%` line, which would otherwise read as a mistake
   * rather than a deliberate choice. */
  deliveryTerms: "DELIVERED" | "EX_WORKS";
};

export type DocSheetData = {
  /** Literal document title — every document is a quote, so this is always
   * "QUOTATION". */
  title: "QUOTATION";
  isDraft: boolean;
  number: string | null;
  issueDate: string;
  /** `DD/MM/YYYY`, computed from `issueDate + (validityDays ??
   * defaultValidityDays)` — always present now, even for a DRAFT that has
   * never had its own validity set (it falls back to the org-wide default —
   * see `ToSheetDataDoc.defaultValidityDays`). `validityDays` can be
   * non-null before finalize too (a per-quote override set from the builder
   * — see `setValidityDays`, src/lib/actions/documents.ts), so a DRAFT can
   * already show its own validity date in preview, computed against its
   * (pre-finalize) `issueDate`; finalize freezes both fields together.
   * Typed nullable for backward compatibility with existing consumers'
   * `data.validityDate ? … : null` checks, but `toSheetData` never actually
   * produces `null` here any more. */
  validityDate: string | null;
  logo: string | null;
  /** Resolved setup-image source (already run through `resolveImage`, same
   * as `logo`), or `null` when the document has none. `null` here means
   * "print nothing at all" — no frame, no placeholder — see
   * `ToSheetDataDoc.heroImageUrl` and quotation-sheet.tsx's `pq-hero-image`
   * block; a quote without one must look finished, not unfinished. */
  heroImage: string | null;
  entity: DocSheetEntity;
  client: DocSheetClient | null;
  /** See `DocSheetDelivery` — `null` whenever there's no client (draft) or
   * the client's delivery address is the same as its main address. */
  delivery: DocSheetDelivery | null;
  items: DocSheetItem[];
  extraLines: DocSheetLine[];
  totals: DocSheetTotals;
  /** Always true — every document shows the signature area. */
  showSignature: boolean;
  /** The document's author, for the "Prepared by" block — see
   * `DocSheetPreparedBy`. */
  preparedBy: DocSheetPreparedBy;
  /** `Document.notes` passthrough — see `ToSheetDataDoc.notes`. */
  notes: string | null;
  /** Passthrough of `ToSheetDataDoc.showItemPrices`/`showOptionPrices` — see
   * that field's doc comment. `quotation-sheet.tsx` computes its own
   * `itemPriceVisible = showItemPrices || showOptionPrices` from these. */
  showItemPrices: boolean;
  showOptionPrices: boolean;
};

// --- helpers ---------------------------------------------------------------

function isNullableString(v: unknown): v is string | null {
  return v === null || typeof v === "string";
}

type EntitySnapshotShape = {
  entityName: string;
  entityLegalId: string | null;
  entityAddress: string | null;
  bankDetails: unknown;
  logoUrl: string | null;
  footerText: string | null;
};

/** Validates `Document.entitySnapshot` at runtime (it's an opaque `Json?`
 * column — Prisma gives no compile-time guarantee it still has the shape
 * `finalizeDocument` wrote). Returns `null` for a missing or malformed
 * snapshot so callers can fall back to the live region fields instead of
 * rendering `undefined`/garbage. */
function parseEntitySnapshot(json: unknown): EntitySnapshotShape | null {
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const obj = json as Record<string, unknown>;
  if (typeof obj.entityName !== "string") return null;
  if (!isNullableString(obj.entityLegalId)) return null;
  if (!isNullableString(obj.entityAddress)) return null;
  if (!isNullableString(obj.logoUrl)) return null;
  if (!isNullableString(obj.footerText)) return null;
  return {
    entityName: obj.entityName,
    entityLegalId: obj.entityLegalId,
    entityAddress: obj.entityAddress,
    bankDetails: "bankDetails" in obj ? obj.bankDetails : null,
    logoUrl: obj.logoUrl,
    footerText: obj.footerText,
  };
}

/** Known `Region.bankDetails` keys (see prisma/seed-lib.ts's `RegionSeed`)
 * mapped to their display label; anything else is humanized from its key
 * (camelCase/snake_case → "Title Case") so an unrecognized key from a future
 * region still renders sensibly instead of being silently dropped. */
const BANK_LABELS: Record<string, string> = {
  bank: "Bank",
  bankName: "Bank",
  accountName: "Account Name",
  accountNo: "Account No.",
  accountNumber: "Account No.",
  swift: "SWIFT",
  swiftCode: "SWIFT",
  bsb: "BSB",
  iban: "IBAN",
  routingNumber: "Routing No.",
  sortCode: "Sort Code",
};

function humanizeBankKey(key: string): string {
  const known = BANK_LABELS[key];
  if (known) return known;
  const spaced = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .trim();
  return spaced.length > 0 ? spaced.charAt(0).toUpperCase() + spaced.slice(1) : key;
}

/** Flattens the opaque `bankDetails` Json into an ordered list of display
 * rows, skipping any non-string value defensively (the column has no
 * compile-time shape guarantee) rather than rendering `"[object Object]"`. */
function toBankRows(bankDetails: unknown): BankDetailRow[] {
  if (!bankDetails || typeof bankDetails !== "object" || Array.isArray(bankDetails)) return [];
  return Object.entries(bankDetails as Record<string, unknown>)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string" && entry[1].trim() !== "")
    .map(([key, value]) => ({ label: humanizeBankKey(key), value }));
}

/**
 * Formats already-resolved bank detail rows (see `DocSheetEntity.bankDetails`
 * / `toBankRows`) into a single newline-joined "Label: value" text block —
 * for a caller that needs bank details as plain multi-line text rather than
 * `quotation-sheet.tsx`'s own `.pq-bank-row` markup, e.g. quotation-data.ts's
 * `{{bankDetails}}` placeholder substitution. Takes the already-resolved
 * `BankDetailRow[]` (not the raw `Json` column) rather than re-deriving from
 * scratch, so it can never disagree with `toSheetData`'s FINAL-vs-DRAFT
 * snapshot resolution (`entitySnapshot` vs. the region's live fields) —
 * every caller shares the exact same label-mapped, already-resolved rows.
 * Markdown-safe: no character `renderMarkdown` treats specially.
 */
export function formatBankDetails(rows: BankDetailRow[]): string {
  return rows.map((row) => `${row.label}: ${row.value}`).join("\n");
}

type AddressLike = {
  street: string | null;
  city: string | null;
  state: string | null;
  postcode: string | null;
  country: string | null;
};

/** Builds the 1-3 line postal address block shared by the main client
 * address and the delivery address (see `toSheetData`) — `country` is
 * rendered through `displayCountry` since it's stored as an ISO alpha-2
 * code (e.g. "AU") going forward, not the English name a reader expects on
 * a printed sheet; a pre-migration free-text value passes through
 * unchanged (see `displayCountry`'s fallback). */
function toAddressLines(address: AddressLike): string[] {
  const lines: string[] = [];
  if (address.street) lines.push(address.street);
  const cityStatePostcode = [address.city, address.state, address.postcode].filter(Boolean).join(", ");
  if (cityStatePostcode) lines.push(cityStatePostcode);
  const country = displayCountry(address.country);
  if (country) lines.push(country);
  return lines;
}

function contactFullName(contact: ToSheetContactInput): string {
  return [contact.firstName, contact.lastName].filter(Boolean).join(" ");
}

/** `qty * unitPrice`, exact (see src/lib/pricing.ts), formatted as a plain
 * 2dp decimal string ready for `formatMoney`. */
function lineTotal(qty: number, unitPrice: string): string {
  return fromCents(qty * toCents(unitPrice)).toFixed(2);
}

/** Same as `lineTotal`, negated when `isCredit` — the salesperson always
 * types a positive `unitPrice` (see `ToSheetItemInput.isCredit`'s doc
 * comment), so the negative sign a credit item's row must print has to be
 * applied here rather than read off the stored value. */
function signedLineTotal(isCredit: boolean, qty: number, unitPrice: string): string {
  const cents = qty * toCents(unitPrice);
  return fromCents(isCredit ? -cents : cents).toFixed(2);
}

/**
 * Returns `description` unless it's redundant with `name` — i.e. `name`
 * and `description` are the same string, or one fully contains the other
 * — in which case the sheet would otherwise render the same text twice
 * (catalog items/options are often named with the full sentence-length
 * description). `null`/empty descriptions pass straight through as `null`
 * so the sheet's `description ? <p>…</p> : null` check stays a clean
 * on/off switch.
 */
export function dedupeDescription(name: string, description: string | null): string | null {
  if (!description) return null;
  if (name === description || name.includes(description) || description.includes(name)) {
    return null;
  }
  return description;
}

/**
 * Builds an item's `ItemBreakdown` — the base/options/discount/subtotal
 * shape every product-line renderer shares (see `ItemBreakdown`'s doc
 * comment). `showOptionPrices` is passed explicitly rather than read off
 * `item` because the two callers want different answers to "are option
 * prices visible": `toSheetData` passes the document's actual
 * `showOptionPrices` toggle (a customer-facing sheet honours it), while
 * `getDocumentForBuilder` always passes `true` (the builder is internal to
 * the salesperson, who always sees full pricing detail regardless of what
 * the toggle is currently set to for the customer-facing sheets). No money
 * arithmetic happens here beyond `lineTotal`'s existing `qty * unitPrice` —
 * `basePrice`/`subtotal`/`discount.amount` are all passed through exactly as
 * the pricing engine already resolved them.
 */
export function buildItemBreakdown(
  item: Pick<
    ToSheetItemInput,
    | "unitPrice"
    | "listPrice"
    | "discountMode"
    | "discountValue"
    | "discountAmount"
    | "total"
    | "lines"
    | "isCredit"
  >,
  showOptionPrices: boolean
): ItemBreakdown {
  // Both prices have to be nothing. The catalogue price alone would swallow a
  // hand-zeroed giveaway, where the "$0" is the message; the charged price
  // alone would swallow a machine the catalogue never priced (`Price.needsReview`
  // snapshots into `listPrice` as 0, indistinguishable here from a deliberate
  // zero) that a salesperson has since priced by hand for real money.
  const basePriceUnquoted =
    item.listPrice !== null && Number(item.listPrice) === 0 && Number(item.unitPrice) === 0;

  return {
    qty: 1,
    basePrice: signedLineTotal(item.isCredit, 1, item.unitPrice),
    basePriceUnquoted,
    assembledFromOptions: basePriceUnquoted && item.lines.length > 0,
    options: item.lines.map((line) => ({
      name: line.name,
      code: line.code,
      description: dedupeDescription(line.name, line.description),
      qty: line.qty,
      // A credit item should never carry options in practice (see
      // `Product.isCredit`'s doc comment) — negated the same way as
      // `basePrice` regardless, so the sign stays consistent across the
      // whole item on the rare/invalid case that it does.
      lineTotal: showOptionPrices ? signedLineTotal(item.isCredit, line.qty, line.unitPrice) : null,
    })),
    // An explicit `0` discount (as opposed to no discount set at all,
    // `discountValue === null`) must render nothing — same "no discount 0%
    // haggling room" fault as the document-level discount row (see
    // quotation-sheet.tsx) — checking the numeric value, not just non-null,
    // is what catches it, for both PERCENT "0" and AMOUNT "0.00". Shared by
    // the customer-facing sheet AND the builder's own `ItemBreakdownEditor`
    // (both render off `breakdown.discount`), so this one change fixes both.
    discount:
      item.discountValue !== null && Number(item.discountValue) !== 0
        ? { mode: item.discountMode, value: item.discountValue, amount: item.discountAmount }
        : null,
    // Already correctly signed by the pricing engine (`EngineItem.isCredit`,
    // see src/lib/pricing.ts) — `total` is `PricingTotals.itemTotals[i]`,
    // never recomputed here.
    subtotal: item.total,
  };
}

function toDocSheetLine(line: ToSheetLineInput, resolveImage: ImageResolver): DocSheetLine {
  return {
    id: line.id,
    code: line.code,
    name: line.name,
    description: dedupeDescription(line.name, line.description),
    qty: line.qty,
    unitPrice: line.unitPrice,
    lineTotal: lineTotal(line.qty, line.unitPrice),
    image: line.showImage && line.imageUrl ? (resolveImage(line.imageUrl) ?? null) : null,
  };
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date.getTime());
  result.setDate(result.getDate() + days);
  return result;
}

// --- toSheetData -------------------------------------------------------------

/**
 * Maps a fully-loaded document into the flat `DocSheetData` shape
 * `buildQuotationData` (src/lib/quotation-data.ts) builds the quotation
 * renderer's data on top of. `resolveImage` lets the caller decide how a
 * stored `/api/files/<name>` URL becomes whatever the render target needs
 * (see `ImageResolver`'s doc comment) — defaults to identity, which is
 * exactly right for the in-app preview route (already-authenticated
 * browser, relative URL just works).
 */
export function toSheetData(doc: ToSheetDataDoc, resolveImage: ImageResolver = identityResolver): DocSheetData {
  const isDraft = doc.status === "DRAFT";

  const snapshot = doc.status === "FINAL" ? parseEntitySnapshot(doc.entitySnapshot) : null;
  const entitySource = snapshot ?? {
    entityName: doc.entityName,
    entityLegalId: doc.entityLegalId,
    entityAddress: doc.entityAddress,
    bankDetails: doc.bankDetails,
    logoUrl: doc.logoUrl,
    footerText: doc.footerText,
  };

  const entity: DocSheetEntity = {
    name: entitySource.entityName,
    legalId: entitySource.entityLegalId,
    address: entitySource.entityAddress,
    bankDetails: toBankRows(entitySource.bankDetails),
    footerText: entitySource.footerText,
  };

  const logo = entitySource.logoUrl ? (resolveImage(entitySource.logoUrl) ?? null) : null;
  const heroImage = doc.heroImageUrl ? (resolveImage(doc.heroImageUrl) ?? null) : null;

  const client: DocSheetClient | null = doc.company
    ? {
        companyName: doc.company.name,
        addressLines: toAddressLines(doc.company),
        website: doc.company.website,
        contactName: doc.contact ? contactFullName(doc.contact) : null,
        contactEmail: doc.contact?.email ?? null,
        contactPhone: doc.contact?.phone ?? null,
      }
    : null;

  const delivery: DocSheetDelivery | null =
    doc.company && doc.company.hasDeliveryAddress
      ? {
          addressLines: toAddressLines({
            street: doc.company.deliveryStreet,
            city: doc.company.deliveryCity,
            state: doc.company.deliveryState,
            postcode: doc.company.deliveryPostcode,
            country: doc.company.deliveryCountry,
          }),
          contactName: doc.company.deliveryContactName,
          phone: doc.company.deliveryPhone,
        }
      : null;

  const items: DocSheetItem[] = doc.items.map((item) => ({
    id: item.id,
    code: item.code,
    name: item.name,
    description: dedupeDescription(item.name, item.description),
    unitPrice: item.unitPrice,
    discountMode: item.discountMode,
    discountValue: item.discountValue,
    total: item.total,
    image: item.showImage && item.imageUrl ? (resolveImage(item.imageUrl) ?? null) : null,
    lines: item.lines.map((line) => toDocSheetLine(line, resolveImage)),
    breakdown: buildItemBreakdown(item, doc.showOptionPrices),
  }));

  // Always resolvable now: the manager's own override when set, otherwise
  // the org-wide default (see `ToSheetDataDoc.defaultValidityDays`) — a
  // draft that has never had `validityDays` set still shows the date it
  // would get if finalized right now, rather than none at all.
  const validityDate = formatDateAU(addDays(doc.issueDate, doc.validityDays ?? doc.defaultValidityDays));

  return {
    title: "QUOTATION",
    isDraft,
    number: doc.number,
    issueDate: formatDateAU(doc.issueDate),
    validityDate,
    logo,
    heroImage,
    entity,
    client,
    delivery,
    items,
    extraLines: doc.extraLines.map((line) => toDocSheetLine(line, resolveImage)),
    preparedBy: {
      name: doc.author.name,
      email: doc.author.email,
      phone: doc.author.phone,
      avatar: doc.author.avatar ? (resolveImage(doc.author.avatar) ?? null) : null,
    },
    notes: doc.notes,
    showItemPrices: doc.showItemPrices,
    showOptionPrices: doc.showOptionPrices,
    totals: {
      currency: doc.currency,
      subtotal: doc.subtotal,
      discountMode: doc.discountMode,
      discountValue: doc.discountValue,
      discountAmount: doc.discountAmount,
      taxName: doc.taxName,
      taxRate: doc.taxRate,
      taxAmount: doc.taxAmount,
      total: doc.total,
      deliveryTerms: doc.deliveryTerms,
    },
    showSignature: true,
  };
}
