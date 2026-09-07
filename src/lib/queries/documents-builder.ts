import { cache } from "react";
import type { DocumentStatus, LineKind, OptionRole, ProductKind, ProductionForm } from "@prisma/client";
import { db } from "@/lib/db";
import { documentWhereForUser, type ScopeUser } from "@/lib/scope";
import { computeTotals, type CommissionResult, type DocumentConcession, type EngineInput } from "@/lib/pricing";
import { getQuoteValidityDays, getCommissionTiers } from "@/lib/queries/settings";

/**
 * The builder's own read: one document, everything on it, priced. By some
 * margin the heaviest read in the app, and the only one here that is
 * request-memoized — see `getDocumentForBuilderInScope` below.
 */

export type BuilderContact = {
  id: string;
  firstName: string;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  position: string | null;
  isPrimary: boolean;
};

export type BuilderCompany = {
  id: string;
  name: string;
  street: string | null;
  city: string | null;
  state: string | null;
  postcode: string | null;
  country: string | null;
  website: string | null;
  /** Resolved server-side as `!deliverySameAsMain` AND at least one
   * delivery* field is actually set — see `toSheetData`'s
   * `ToSheetCompanyInput.hasDeliveryAddress`, which this feeds directly
   * (structurally — `BuilderCompany` satisfies that type without either
   * file importing the other). Lets both the builder and the sheets skip
   * rendering a "different delivery address" block for a company that has
   * the flag off, or on but with nothing actually filled in. */
  hasDeliveryAddress: boolean;
  deliveryStreet: string | null;
  deliveryCity: string | null;
  deliveryState: string | null;
  deliveryPostcode: string | null;
  deliveryCountry: string | null;
  deliveryContactName: string | null;
  deliveryPhone: string | null;
  contacts: BuilderContact[];
};

export type BuilderLine = {
  id: string;
  kind: LineKind;
  /** For an OPTION line: the `Option.id` it was added from -- what the
   * options editor keys its selection by and resubmits to `setItemOptions`,
   * since `code` below is a snapshot label the catalogue may have renamed
   * since. `null` for a CUSTOM line (no catalogue row). */
  refId: string | null;
  code: string | null;
  name: string;
  description: string | null;
  qty: number;
  unitPrice: string;
  /** `DocumentLine.listPrice` — the catalogue price at the moment this line
   * was added, or `null` for a CUSTOM line (no catalogue entry to snapshot
   * one from) or a pre-migration OPTION row that predates this column. Feeds
   * the builder's "list price struck through" hint next to a hand-edited
   * OPTION line's price (see `LineUnitPriceField`) — never rendered on a
   * customer-facing sheet (see src/lib/sheet-data.ts, which never reads this
   * field at all). */
  listPrice: string | null;
  /** `DocumentLine.attributes` (e.g. `{ metres: 4 }`) as stored — only
   * meaningful on OPTION lines whose option has an `attributeSchema`; loosely
   * typed since it's opaque JSON round-tripped straight from the option
   * editor into storage and back. */
  attributes: Record<string, string | number> | null;
  sortOrder: number;
  /** For an OPTION line: `Option.role`, resolved by `refId` against the
   * catalog the same live way `imageUrl` below is. What the builder uses to
   * tell an EasyLoader's derived module rows (see `EL_MODULE_ROLES`) from
   * the manager's own picks. `null` for a line with no `refId`, an option
   * with no role, or any non-OPTION line. */
  role: OptionRole | null;
  /** For an OPTION line: `Option.imageUrl`, resolved by `refId` against the
   * catalog (see `getDocumentForBuilder`'s `optionImageMap`) — not a
   * snapshot column on `DocumentLine` itself, so this always reflects the
   * option's *current* catalog image, same live-lookup treatment
   * `listCompatibleOptions` gives the options editor's own icons. `null` for
   * an OPTION with no `refId` or no catalog image set. Feeds
   * `QuotationLineInput.imageUrl` (src/lib/quotation-data.ts) for the
   * quotation's unified options table.
   *
   * For a CUSTOM (document-level extra) line: `DocumentLine.imageUrl`
   * itself — a trade-in or bought-in item's own photo, since it has no
   * catalog entry to inherit one from. `null` when none was attached.
   *
   * Always `null` for a PRODUCT line (the item's own image lives on
   * `BuilderItem.imageUrl` instead). */
  imageUrl: string | null;
  /** Whether the line's `imageUrl` should actually render on a sheet/PDF —
   * same gating role as `BuilderItem.showImage`, but only ever set true for
   * a CUSTOM line (by `addCustomLine`, when a photo was attached — there's
   * no separate toggle for it, unlike an item's image). Always `false` for
   * an OPTION line today (never set by `setItemOptions`). */
  showImage: boolean;
};

export type BuilderItem = {
  id: string;
  code: string;
  name: string;
  description: string | null;
  unitPrice: string;
  /** `DocumentItem.listPrice` — see `BuilderLine.listPrice`'s doc comment,
   * same rule one level up. `null` only for a pre-migration row; every item
   * `addItem` creates going forward gets one. */
  listPrice: string | null;
  discountMode: "PERCENT" | "AMOUNT";
  discountValue: string | null;
  /** The document's region's discount cap (`Region.maxDiscountPct`) — the
   * same value on every item of a given document, not a per-item/per-series
   * value (discount caps moved from Series to Region — see setItemDiscount
   * in src/lib/actions/documents.ts). `null` means no cap. */
  maxDiscountPct: string | null;
  /** The item's product's series id — needed, alongside `productId`, to
   * look up which options are compatible with it (see
   * `listCompatibleOptions`). `null` only in the defensive case of a
   * snapshot item whose product record no longer resolves a series
   * (shouldn't happen: deleting a referenced product is blocked — see
   * `deleteProduct` in actions/catalog.ts). */
  seriesId: string | null;
  /** The item's product's `Series.name` (e.g. "M-Series", "X-Calibre") —
   * display only, the one piece of prose the quotation's spec sentence
   * needs (`machineSpecSentence`, src/lib/machine-specs.ts). Never an
   * identity: nothing branches on it. `null` in the same defensive case as
   * `seriesId`. */
  seriesName: string | null;
  /** The item's own product id — options can be compatible at the
   * product level as well as the series level (see `OptionCompatibility`),
   * so callers need both ids to look up the full compatible-options set.
   * `null` only in the same defensive case as `seriesId`. */
  productId: string | null;
  /** `Product.kind`, read live off the joined product. ACCESSORY for an
   * item whose product no longer resolves (same defensive case as
   * `seriesId`) -- the kind a custom line with no catalogue entry has. */
  kind: ProductKind;
  /** `Product.form` -- which production order form this item prints on
   * (see `resolveForm`), or `null` for none. Drives which production-spec
   * editor the builder card shows and whether the EasyLoader builder
   * replaces the options panel. */
  form: ProductionForm | null;
  /** `Product.specs` exactly as stored (opaque `Json?`, e.g.
   * `{ cutHeightCm, cutWidthCm }`) — carried through unvalidated for
   * `buildQuotationData`'s placeholder substitution, which validates its
   * shape defensively at runtime. `null` for an item with no resolving
   * product or no specs recorded. */
  specs: unknown;
  /** `Series.quoteDescription` of the item's product's category, read live
   * from the catalog (not snapshotted on the item) so fixing a typo in a
   * category's copy shows on every DRAFT quote at once. A FINAL quote reads
   * its frozen snapshot instead — see Plan 3. */
  seriesQuoteDescription: string | null;
  /** `DocumentItem.serialNumber` — set post-installation, used as-is in the
   * quotation's RSP coverage table. Not editable anywhere in the builder for
   * an ordinary item; for a credit item (`isCredit`) it's opened up via
   * `setItemSerialNumber` so a salesperson can record the traded-in
   * machine's serial number. */
  serialNumber: string | null;
  /** `Product.isCredit`, read live off the joined product (same rule as
   * `seriesId`/`seriesName`/`specs` above) — true for the TRADE-IN product.
   * Drives the negative-amount rendering in `buildItemBreakdown`
   * (src/lib/sheet-data.ts) and gates the serial-number/description edit UI
   * for this item in the builder (`items-list.tsx`). See the doc comment on
   * `EngineItem.isCredit` in src/lib/pricing.ts for why the sign lives on
   * the product, not on what the salesperson types. */
  isCredit: boolean;
  /** `Product.noCommission`, read live off the joined product (same rule as
   * `isCredit` above). The engine already consumes this to keep the line out
   * of the commission base and out of any percentage discount; the builder
   * card additionally tints itself so a salesperson sees at a glance that
   * this line earns them nothing — otherwise the only way to find out is to
   * notice the commission figure failing to move. */
  noCommission: boolean;
  imageUrl: string | null;
  /** Whether the item's thumbnail should actually be shown on a rendered
   * document (the sheet renderer/PDF) — distinct from `imageUrl` being
   * present, since a product snapshot can carry an image the author hasn't
   * opted to display. Toggleable from the builder UI via `setItemShowImage`
   * (src/lib/actions/documents.ts); the sheet renderer/PDF (src/lib/sheet-data.ts)
   * only shows the thumbnail when both this and `imageUrl` are set. */
  showImage: boolean;
  /** Same presence check as `imageUrl !== null`, exposed as its own boolean
   * so the builder card can gate the "Show image in PDF" checkbox on it
   * without every caller re-deriving that null-check itself. */
  productHasImage: boolean;
  sortOrder: number;
  lines: BuilderLine[];
  /** This item's own line (base price + its OPTION lines, discounted) as
   * computed by the pricing engine — display-only, mirrors what
   * `recalcDocument` persists at the document level but isn't itself stored
   * per item. */
  total: string;
  /** The item discount resolved to a cash amount (`0.00` when unset) — from
   * the same `computeTotals` call that produces `total` above
   * (`PricingTotals.itemDiscounts`), never re-derived. Feeds
   * `ToSheetItemInput.discountAmount` / `ItemBreakdown.discount.amount`. */
  discountAmount: string;
  /** `DocumentItem.productionSpec` exactly as stored (opaque `Json?`,
   * validated by `specSchemaForForm` on write) — `{}` when nothing has been
   * answered yet. Only meaningful for an item whose `form` is set. */
  productionSpec: unknown;
};

export type DocumentForBuilder = {
  id: string;
  status: DocumentStatus;
  number: string | null;
  issueDate: Date;
  /** `Document.validityDays` — `null` means "use the org-wide
   * `quote.validityDays` setting" (see `getQuoteValidityDays`,
   * src/lib/queries/settings.ts); a non-null value is a per-quote override
   * set from the builder (see `setValidityDays`, src/lib/actions/documents.ts)
   * for a customer whose approval process runs longer than the usual
   * window. Frozen onto the document at finalize time either way — see
   * `finalizeDocument`'s `document.validityDays ?? (await
   * getQuoteValidityDays())` fallback — so this can be non-null on a DRAFT
   * (an author's own override, not yet finalized) as well as on a FINAL
   * document (the value frozen when it was finalized). */
  validityDays: number | null;
  /** The org-wide default (`Setting` key "quote.validityDays", via
   * `getQuoteValidityDays`) resolved *at read time* — always a number,
   * never the raw override. Exists so `toSheetData` can show a "Valid
   * until" date on a DRAFT that has never had `validityDays` set (the
   * builder's own field stays `null` in that case — see that field's doc
   * comment above — so it can still tell "nothing typed" from "typed 30"
   * apart; this is the *fallback* the sheet computes from, not a value
   * ever written back onto the document). `finalizeDocument` resolves the
   * same default independently (via `getQuoteValidityDays` directly) when
   * it freezes `validityDays` onto the document — this field is read-only
   * display plumbing and never fed back into that write. */
  defaultValidityDays: number;
  currency: string;
  taxName: string;
  taxRate: string;
  /** DELIVERED (the default) or EX_WORKS — see the `DeliveryTerms` enum in
   * schema.prisma and `setDeliveryTerms`/`recalcDocument` in
   * src/lib/actions/documents.ts, which zeroes an EX_WORKS document's
   * effective tax. Surfaced here so the builder's selector (see
   * `DeliveryTermsField`) and the sheet renderers (see `ToSheetDataDoc`,
   * which this structurally satisfies) both read it straight off the
   * document. */
  deliveryTerms: "DELIVERED" | "EX_WORKS";
  discountMode: "PERCENT" | "AMOUNT";
  discountValue: string | null;
  subtotal: string;
  /** subtotal - taxableBase, i.e. the amount the document-level discount
   * removes — 0 when `discountValue` is null. */
  discountAmount: string;
  /** Full price before item-level and document-level discounts, for the
   * builder Summary breakdown. */
  summarySubtotal: string;
  /** Combined item-level and document-level discount, for Summary. */
  summaryDiscountAmount: string;
  /** The whole-document region-discount-cap check (see `DocumentConcession`
   * in src/lib/pricing.ts) — same figure `recalcDocument`/`recalcAndEnforce`
   * (src/lib/actions/documents.ts) enforce on every save and
   * `finalizeDocument` re-checks. Surfaced here so the builder can display
   * it (e.g. an "exceeds cap" banner) without a second `computeTotals` run;
   * always present, `exceedsCap` is what a caller actually branches on. */
  documentConcession: DocumentConcession;
  /** The salesperson's commission on this document — see `CommissionResult`
   * in src/lib/pricing.ts. For a DRAFT, computed live every read (same
   * engine call as everything else here); for a FINAL document, read back
   * from the frozen `Document.commissionAmount`/`commissionRatePct`/
   * `commissionBase` columns instead (see `finalizeDocument`,
   * src/lib/actions/finalize.ts) so a later edit to the commission-tier
   * table never rewrites what an already-issued quote is recorded as
   * having paid out. `null` either when no commission tier table is
   * configured (`getCommissionTiers`, src/lib/queries/settings.ts) or,
   * for a FINAL document, when none was configured *at finalize time* —
   * the builder must show nothing at all in either case, never a
   * misleading $0.00 (see `CommissionResult`'s doc comment). Internal-only:
   * this must never be threaded into `buildQuotationData`/`QuotationSheet`
   * or any other customer-facing render — see the doc comment on those
   * modules for why the two pipelines stay entirely separate. */
  commission: CommissionResult | null;
  taxAmount: string;
  total: string;
  regionId: string;
  regionCode: string;
  /** `Region.name` (e.g. "Australia") — surfaced alongside `documentConcession`
   * so the builder can build the same "... above the X% limit for
   * <region>" message `concessionCapMessage` produces server-side elsewhere
   * (`recalcDocument`'s `concessionMessage`) without a second query; see
   * `ConcessionCapBadge`/`ConcessionCapToast`. */
  regionName: string;
  /** `Document.entitySnapshot` exactly as stored (an opaque `Json?` column,
   * frozen by `finalizeDocument` — see its doc comment for the shape it
   * writes) — `null` for a document that has never been finalized.
   * Consumers that need to read it (the document sheet mapper) are
   * responsible for validating its shape at runtime since Prisma's `Json`
   * type gives no compile-time guarantee. */
  entitySnapshot: unknown;
  /** The document's *region*'s current entity identity fields — i.e. the
   * live values, not a frozen snapshot. Used as-is to render a DRAFT (which
   * has no snapshot yet); a FINAL document's renderer should prefer
   * `entitySnapshot` instead so an admin editing the region later never
   * retroactively changes an already-issued document. */
  entityName: string;
  entityLegalId: string | null;
  entityAddress: string | null;
  bankDetails: unknown;
  logoUrl: string | null;
  footerText: string | null;
  company: BuilderCompany | null;
  contactId: string | null;
  contact: BuilderContact | null;
  items: BuilderItem[];
  extraLines: BuilderLine[];
  /** `Document.notes` — free-text, admin-authored markdown edited from the
   * builder's Notes section (see `setDocumentNotes`) and rendered on both
   * the quotation and plain document sheets (see `ToSheetDataDoc.notes`).
   * `null` when nothing's been written. */
  notes: string | null;
  /** The document's author — feeds the "Prepared by" block (see
   * `ToSheetAuthorInput`/`DocSheetPreparedBy` in src/lib/sheet-data.ts).
   * Always present: `Document.authorId` is a required field. `avatar` is
   * `User.image` — NextAuth's own profile-picture column, reused here as
   * the "Prepared by" photo (see src/lib/actions/users.ts's `setUserAvatar`
   * for the write side) since this app's credentials/magic-link auth never
   * populates it on its own — a stored `/api/files/<name>` URL that
   * `toSheetData` must resolve through its `ImageResolver` the same way it
   * already does `logoUrl`/item images, or the PDF pipeline would embed a
   * URL Gotenberg's headless Chromium can't fetch. */
  author: { name: string | null; email: string; phone: string | null; avatar: string | null };
  /** Quotation-first pricing display toggles (see `setPriceDisplay` in
   * src/lib/actions/documents.ts) — the builder only ever surfaces its
   * toggle card for a QUOTE, but both flags are read straight through into
   * `QuotationDataDoc` regardless of `type` (see `buildQuotationData`). */
  showItemPrices: boolean;
  showOptionPrices: boolean;
  /** `Document.heroImageUrl` — see that column's doc comment in
   * schema.prisma. `toSheetData` resolves it through its `ImageResolver`
   * exactly like `logoUrl`/`author.avatar` above, so this stays an
   * unresolved `/api/files/<name>` URL (or `null`) here. */
  heroImageUrl: string | null;
  updatedAt: Date;
};

/** The live catalog facts an OPTION line reads off its option. */
type OptionRow = {
  imageUrl: string | null;
  noCommission: boolean;
  role: OptionRole | null;
};

/**
 * `optionRowMap` (optionId -> the option's live `imageUrl`/`role`, built
 * once per `getDocumentForBuilder` call from every
 * OPTION line's `refId` — see below) resolves those for an OPTION line (an
 * OPTION with no `refId` or no matching catalog row gets `null` for all); a
 * CUSTOM line uses its own `imageUrl`/`showImage` columns instead (there's
 * no catalog entry to resolve); a PRODUCT line always gets `null` (its
 * image lives on `BuilderItem.imageUrl`).
 */
function toBuilderLine(
  line: {
    id: string;
    kind: LineKind;
    code: string | null;
    name: string;
    description: string | null;
    qty: number;
    unitPrice: { toString(): string };
    listPrice: { toString(): string } | null;
    attributes: unknown;
    sortOrder: number;
    refId: string | null;
    imageUrl: string | null;
    showImage: boolean;
  },
  optionRowMap: Map<string, OptionRow>
): BuilderLine {
  const optionRow = line.kind === "OPTION" && line.refId ? optionRowMap.get(line.refId) : undefined;
  return {
    id: line.id,
    kind: line.kind,
    refId: line.refId,
    code: line.code,
    name: line.name,
    description: line.description,
    qty: line.qty,
    unitPrice: line.unitPrice.toString(),
    listPrice: line.listPrice !== null ? line.listPrice.toString() : null,
    attributes:
      line.attributes && typeof line.attributes === "object" && !Array.isArray(line.attributes)
        ? (line.attributes as Record<string, string | number>)
        : null,
    sortOrder: line.sortOrder,
    role: optionRow?.role ?? null,
    imageUrl: line.kind === "OPTION" ? (optionRow?.imageUrl ?? null) : line.imageUrl,
    showImage: line.kind === "OPTION" ? false : line.showImage,
  };
}

function toBuilderContact(contact: {
  id: string;
  firstName: string;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  position: string | null;
  isPrimary: boolean;
}): BuilderContact {
  return {
    id: contact.id,
    firstName: contact.firstName,
    lastName: contact.lastName,
    email: contact.email,
    phone: contact.phone,
    position: contact.position,
    isPrimary: contact.isPrimary,
  };
}

/**
 * The full document a builder page needs to render: client (company, with
 * its contacts ordered primary-first then by first name) + contact,
 * region, every item (ordered by sortOrder) with its option/product lines
 * (also ordered by sortOrder), and the document-level lines (`itemId` is
 * null — freeform "extra lines" like delivery). Returns `null` both when
 * the document doesn't exist and when it's out of `user`'s scope (a
 * manager opening another manager's document) — callers should 404 either
 * way, never distinguishing the two.
 *
 * The real work is request-memoized (see `getDocumentForBuilderInScope`
 * below), which is why this outer function exists at all: both pages that
 * load a document — the builder and the quotation preview — fetch it once in
 * `generateMetadata` and again in the page body, and this is by some margin
 * the heaviest read in the app.
 */
export function getDocumentForBuilder(
  user: ScopeUser,
  id: string
): Promise<DocumentForBuilder | null> {
  return getDocumentForBuilderInScope(user.id, user.role, id);
}

/** Memoization boundary for `getDocumentForBuilder` above, taking the scope
 * as its two primitive parts rather than the `ScopeUser` itself: React's
 * `cache` matches object arguments by identity, and each `auth()` call
 * deserializes a fresh `session.user`, so a `ScopeUser` parameter would miss
 * on every call and quietly memoize nothing. Both parts are part of the key
 * because both shape the query — `documentWhereForUser` reads the role to
 * decide whether the id restricts anything at all. */
const getDocumentForBuilderInScope = cache(async function getDocumentForBuilderInScope(
  userId: string,
  role: string,
  id: string
): Promise<DocumentForBuilder | null> {
  const user: ScopeUser = { id: userId, role };
  const document = await db.document.findFirst({
    where: { id, ...documentWhereForUser(user) },
    include: {
      region: true,
      // `image` here is `User.image` reused as the avatar — see the
      // `author` field's doc comment above.
      author: { select: { name: true, email: true, phone: true, image: true } },
      company: {
        include: {
          contacts: { orderBy: [{ isPrimary: "desc" }, { firstName: "asc" }] },
        },
      },
      contact: true,
      items: {
        orderBy: { sortOrder: "asc" },
        include: {
          lines: { orderBy: { sortOrder: "asc" } },
          product: { include: { series: true } },
        },
      },
      lines: {
        where: { itemId: null },
        orderBy: { sortOrder: "asc" },
      },
    },
  });
  if (!document) return null;

  // Resolved once here (not written back onto `document.validityDays`) —
  // see `defaultValidityDays`'s doc comment above. `commissionTiers` is
  // fetched alongside it for the same reason — a read-time default, never
  // persisted onto the document itself (see `CommissionResult`'s doc
  // comment on `DocumentForBuilder` for the null-vs-configured distinction).
  const [defaultValidityDays, commissionTiers] = await Promise.all([getQuoteValidityDays(), getCommissionTiers()]);

  // Every OPTION line's icon in the quotation's unified options table (see
  // src/lib/quotation-data.ts's QuotationOptionRow) comes from the option's
  // *current* catalog `imageUrl`, not a snapshot on the line — `DocumentLine`
  // has no `imageUrl` column, only `refId` (the optionId). One query up
  // front for every distinct refId referenced anywhere in the document
  // (item lines + document-level extra lines) beats a per-line round trip.
  const optionRefIds = Array.from(
    new Set(
      document.items
        .flatMap((item) => item.lines)
        .concat(document.lines)
        .filter((line): line is (typeof document.lines)[number] & { refId: string } => line.kind === "OPTION" && line.refId !== null)
        .map((line) => line.refId)
    )
  );
  // `Option.noCommission` (see the commission section below) and
  // `Option.role` (see `BuilderLine.role`) are read the same way — live off
  // the option, not a line snapshot — so this one query covers both needs
  // rather than adding a round trip per fact.
  const optionRows =
    optionRefIds.length > 0
      ? await db.option.findMany({
          where: { id: { in: optionRefIds } },
          select: { id: true, imageUrl: true, noCommission: true, role: true },
        })
      : [];
  const optionRowMap = new Map<string, OptionRow>(
    optionRows.map((o) => [o.id, { imageUrl: o.imageUrl, noCommission: o.noCommission, role: o.role }])
  );
  const optionNoCommissionMap = new Map(optionRows.map((o) => [o.id, o.noCommission]));

  // Item totals and the document discount amount aren't persisted per row
  // (recalcDocument only writes the document-level subtotal/tax/total) —
  // recompute them here with the same pure engine so the builder can show
  // "item total" and "discount: -$X" without duplicating the math.
  // The discount cap is the document's region cap (Region.maxDiscountPct) —
  // the same value on every item, not a per-item/series value; see
  // setItemDiscount in src/lib/actions/documents.ts for the enforcement
  // side of this move from Series to Region.
  const regionMaxDiscountPct = document.region.maxDiscountPct ? Number(document.region.maxDiscountPct) : null;
  const regionMaxMarkupPct = document.region.maxMarkupPct ? Number(document.region.maxMarkupPct) : null;
  const engineInput: EngineInput = {
    items: document.items.map((item) => ({
      unitPrice: Number(item.unitPrice),
      listPrice: item.listPrice !== null ? Number(item.listPrice) : null,
      discountMode: item.discountMode,
      discountValue: item.discountValue !== null ? item.discountValue.toString() : null,
      maxDiscountPct: regionMaxDiscountPct,
      isCredit: item.product?.isCredit ?? false,
      // `Product.noCommission`, read live off the joined product — same
      // rule as `isCredit` above (see that field's own doc comment).
      isNoCommission: item.product?.noCommission ?? false,
      lines: item.lines.map((line) => ({
        qty: line.qty,
        unitPrice: Number(line.unitPrice),
        listPrice: line.listPrice !== null ? Number(line.listPrice) : null,
        // `Option.noCommission`, read live off `optionNoCommissionMap`
        // (built above from the same query that resolves each line's
        // icon) — every line here is kind OPTION with a non-null `refId`
        // (see the doc comment on `optionRefIds` above), so this always
        // finds a row once the option itself exists.
        isNoCommission: line.refId !== null ? (optionNoCommissionMap.get(line.refId) ?? false) : false,
      })),
    })),
    extraLines: document.lines.map((line) => ({ qty: line.qty, unitPrice: Number(line.unitPrice) })),
    documentDiscountMode: document.discountMode,
    documentDiscountValue: document.discountValue !== null ? document.discountValue.toString() : null,
    regionMaxDiscountPct,
    regionMaxMarkupPct,
    taxRate: Number(document.taxRate),
    commissionTiers,
  };
  const totals = computeTotals(engineInput);

  // Commission is frozen at finalize time (`Document.commissionAmount`/
  // `commissionRatePct`/`commissionBase` — see finalizeDocument,
  // src/lib/actions/finalize.ts, and those columns' own doc comment in
  // schema.prisma): a FINAL document reads back exactly what was frozen
  // then, rather than `totals.commission` above (which would otherwise
  // silently drift if the commission-tier table is edited afterwards — the
  // whole point of freezing it). A DRAFT always uses the live
  // `totals.commission` so the builder keeps showing an up-to-date figure
  // while a quote is still being put together. All three columns are
  // always written/read together (see that doc comment) — `null` across
  // all three means either "never finalized" or "finalized with no
  // commission-tier table configured", the same `CommissionResult | null`
  // shape either way.
  const commission: CommissionResult | null =
    document.status === "FINAL"
      ? document.commissionAmount !== null && document.commissionRatePct !== null && document.commissionBase !== null
        ? {
            base: document.commissionBase.toString(),
            ratePct: Number(document.commissionRatePct),
            amount: document.commissionAmount.toString(),
          }
        : null
      : totals.commission;

  return {
    id: document.id,
    status: document.status,
    number: document.number,
    issueDate: document.issueDate,
    validityDays: document.validityDays,
    defaultValidityDays,
    currency: document.currency,
    taxName: document.taxName,
    taxRate: document.taxRate.toString(),
    deliveryTerms: document.deliveryTerms,
    discountMode: document.discountMode,
    discountValue: document.discountValue?.toString() ?? null,
    subtotal: document.subtotal.toString(),
    discountAmount: totals.discountAmount.toString(),
    summarySubtotal: totals.grossSubtotal.toString(),
    summaryDiscountAmount: totals.totalDiscountAmount.toString(),
    documentConcession: totals.documentConcession,
    commission,
    taxAmount: document.taxAmount.toString(),
    total: document.total.toString(),
    regionId: document.regionId,
    regionCode: document.region.code,
    regionName: document.region.name,
    entitySnapshot: document.entitySnapshot,
    entityName: document.region.entityName,
    entityLegalId: document.region.entityLegalId,
    entityAddress: document.region.entityAddress,
    bankDetails: document.region.bankDetails,
    logoUrl: document.region.logoUrl,
    footerText: document.region.footerText,
    company: document.company
      ? {
          id: document.company.id,
          name: document.company.name,
          street: document.company.street,
          city: document.company.city,
          state: document.company.state,
          postcode: document.company.postcode,
          country: document.company.country,
          website: document.company.website,
          // "Distinct delivery address" needs both the flag AND actual data
          // — a company with `deliverySameAsMain` off but every delivery
          // field still blank (e.g. right after unchecking the box, before
          // saving) has nothing worth rendering as a separate block.
          hasDeliveryAddress:
            !document.company.deliverySameAsMain &&
            Boolean(
              document.company.deliveryStreet ||
                document.company.deliveryCity ||
                document.company.deliveryPostcode ||
                document.company.deliveryCountry
            ),
          deliveryStreet: document.company.deliveryStreet,
          deliveryCity: document.company.deliveryCity,
          deliveryState: document.company.deliveryState,
          deliveryPostcode: document.company.deliveryPostcode,
          deliveryCountry: document.company.deliveryCountry,
          deliveryContactName: document.company.deliveryContactName,
          deliveryPhone: document.company.deliveryPhone,
          contacts: document.company.contacts.map(toBuilderContact),
        }
      : null,
    contactId: document.contactId,
    contact: document.contact ? toBuilderContact(document.contact) : null,
    items: document.items.map((item, index) => ({
      id: item.id,
      code: item.code,
      name: item.name,
      description: item.description,
      unitPrice: item.unitPrice.toString(),
      listPrice: item.listPrice !== null ? item.listPrice.toString() : null,
      discountMode: item.discountMode,
      discountValue: item.discountValue?.toString() ?? null,
      maxDiscountPct: document.region.maxDiscountPct?.toString() ?? null,
      seriesId: item.product?.seriesId ?? null,
      seriesName: item.product?.series.name ?? null,
      productId: item.product?.id ?? null,
      kind: item.product?.kind ?? "ACCESSORY",
      form: item.product?.form ?? null,
      specs: item.product?.specs ?? null,
      seriesQuoteDescription: item.product?.series?.quoteDescription ?? null,
      serialNumber: item.serialNumber,
      isCredit: item.product?.isCredit ?? false,
      noCommission: item.product?.noCommission ?? false,
      imageUrl: item.imageUrl,
      showImage: item.showImage,
      productHasImage: item.imageUrl !== null,
      sortOrder: item.sortOrder,
      lines: item.lines.map((line) => toBuilderLine(line, optionRowMap)),
      total: totals.itemTotals[index].toString(),
      discountAmount: totals.itemDiscounts[index].toString(),
      productionSpec: item.productionSpec,
    })),
    extraLines: document.lines.map((line) => toBuilderLine(line, optionRowMap)),
    notes: document.notes,
    author: {
      name: document.author.name,
      email: document.author.email,
      phone: document.author.phone,
      avatar: document.author.image,
    },
    showItemPrices: document.showItemPrices,
    showOptionPrices: document.showOptionPrices,
    heroImageUrl: document.heroImageUrl,
    updatedAt: document.updatedAt,
  };
});
