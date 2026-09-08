/**
 * The document behind a signing token, for an unauthenticated visitor — the
 * one read the whole `/sign` route is allowed to make (see src/proxy.ts's
 * PUBLIC_PATHS and the route group's own layout, neither of which may call
 * `auth()` or import from `(app)`).
 *
 * Written from scratch rather than reusing the builder's own document read
 * (src/lib/queries/documents-builder.ts), and deliberately never importing
 * that module. That query selects `commissionAmount`, `commissionRatePct`
 * and `commissionBase` — a manager's payout that must never reach a client.
 * Showing a client the manager's commission is an incident, not a bug, and
 * the way it would happen is not malice but reuse: someone reaching for the
 * builder's read because it already returns everything the sheet needs.
 * `tests/signing-exposure.test.ts` reads this file's source text and fails
 * the build if a commission field or an import of the builder module ever
 * appears here. That guard is textual, so it cannot see an `include` or a
 * concatenated key that never spells the word out — `assertNoCommissionLeak`
 * below is the same check at the one point where the shape is real.
 *
 * `notes` IS selected, deliberately: it is `Document.notes`, the same single
 * column already rendered into the PDF the manager sends the client (see
 * `NotesSection` / `QuotationSheet`, included unconditionally). Withholding
 * it here would show the client a different document from the one they are
 * signing.
 *
 * Lookup is by token hash, the unique column — the raw token never reaches
 * the database (see src/lib/signing/token.ts).
 */
import { db } from "@/lib/db";
import { computeTotals, type EngineInput } from "@/lib/pricing";
import { getQuoteValidityDays } from "@/lib/queries/settings";
import type { QuotationDataDoc, QuotationItemInput, QuotationLineInput } from "@/lib/quotation-data";
import type { LineKind, OptionRole, ProductKind, SigningStatus } from "@prisma/client";

/** The live catalog facts an OPTION line reads off its option — the same
 * shape the builder's own document read resolves, and for the same reason:
 * an option's icon and role live on the catalog row, not snapshotted onto
 * the line. */
type OptionRow = {
  imageUrl: string | null;
  role: OptionRole | null;
  unitLengthM: number | null;
  /** Whether a discount may reach this option line at all (see
   * `EngineItemLine.isNoCommission` in src/lib/pricing.ts) — the pricing
   * engine's rule, not a payout figure: a line flagged this way is carved out
   * of the discount base before the item's own discount is resolved, which
   * changes what the CUSTOMER is charged. Feeding it into `computeTotals`
   * below is what keeps this query's item totals correct for such a line;
   * the amount that flag would otherwise gate (a salesperson's payout) is
   * never read or returned by this file. */
  noCommission: boolean;
};

type RawLine = {
  id: string;
  kind: LineKind;
  code: string | null;
  name: string;
  description: string | null;
  qty: number;
  unitPrice: { toString(): string };
  listPrice: { toString(): string } | null;
  attributes: unknown;
  refId: string | null;
  imageUrl: string | null;
  showImage: boolean;
};

function toSigningLine(line: RawLine, optionRowMap: Map<string, OptionRow>): QuotationLineInput {
  const optionRow = line.kind === "OPTION" && line.refId ? optionRowMap.get(line.refId) : undefined;
  return {
    id: line.id,
    kind: line.kind,
    code: line.code,
    name: line.name,
    description: line.description,
    qty: line.qty,
    unitPrice: line.unitPrice.toString(),
    attributes:
      line.attributes && typeof line.attributes === "object" && !Array.isArray(line.attributes)
        ? (line.attributes as Record<string, string | number>)
        : null,
    role: optionRow?.role ?? null,
    unitLengthM: optionRow?.unitLengthM ?? null,
    imageUrl: line.kind === "OPTION" ? (optionRow?.imageUrl ?? null) : line.imageUrl,
    showImage: line.kind === "OPTION" ? false : line.showImage,
  };
}

/**
 * The document a signing token unlocks, matching `QuotationDataDoc`
 * (src/lib/quotation-data.ts) exactly plus the three fields the page itself
 * needs beyond what `buildQuotationData` consumes: `id` (to write the
 * view-tracking update), `signingStatus` (fed to `resolveLinkState`) and
 * `signedPdfName` (a later task's PDF route). Annotated explicitly, rather
 * than left for the page to discover at its own call site, so this file's own
 * `npm run typecheck` catches a missing field the moment the select is wrong
 * — the whole point of building the select by copying the builder's, deleting
 * what must never appear here, and letting the compiler finish the list.
 */
type SigningDocument = QuotationDataDoc & {
  id: string;
  signingStatus: SigningStatus;
  signedPdfName: string | null;
};

export type DocumentForSigning = {
  id: string;
  expiresAt: Date;
  revokedAt: Date | null;
  declinedAt: Date | null;
  firstViewedAt: Date | null;
  email: string;
  contact: { firstName: string; lastName: string | null } | null;
  document: SigningDocument;
};

// The source-text guard in tests/signing-exposure.test.ts catches an author
// who names a commission field. It cannot catch one who reuses the whole row
// -- an `include` instead of a `select`, or a key built by concatenation --
// because the forbidden word never appears. This is the same check at the
// only point where the shape is real rather than textual.
const FORBIDDEN_KEYS = ["commissionAmount", "commissionRatePct", "commissionBase"] as const;

/**
 * Throws if `document` -- the object about to be handed back from
 * `getDocumentForSigning` to an unauthenticated signer -- carries any of
 * `Document`'s three commission columns (see prisma/schema.prisma). Runs on
 * every call, right before the function returns, against the one document
 * object this route ever produces.
 *
 * Throws rather than stripping the keys: a silent filter would hide the
 * mistake and let it reach the next person as a mystery. The message names
 * both the offending key and this function so whoever trips it knows
 * immediately what they did.
 *
 * Does not cover: commission data smuggled into one of the opaque JSON
 * columns already selected above (`entitySnapshot`, `documentsSnapshot`,
 * `attributes`) -- those are typed `unknown` and never inspected field by
 * field; a differently-named alias for the same figures (e.g. `payoutAmount`
 * copied from `commissionAmount`); or a leak introduced by some other query
 * entirely. It only catches this exact row carrying one of these three exact
 * keys, which is what an `include`-shaped rewrite of this function would do.
 */
function assertNoCommissionLeak(document: Record<string, unknown>): void {
  for (const key of FORBIDDEN_KEYS) {
    if (key in document) {
      throw new Error(
        `getDocumentForSigning: forbidden key "${key}" is present on the document about to be returned to an unauthenticated signer`
      );
    }
  }
}

export async function getDocumentForSigning(tokenHash: string): Promise<DocumentForSigning | null> {
  const request = await db.signingRequest.findUnique({
    where: { tokenHash },
    select: {
      id: true,
      expiresAt: true,
      revokedAt: true,
      declinedAt: true,
      firstViewedAt: true,
      email: true,
      contact: { select: { firstName: true, lastName: true } },
      document: {
        select: {
          id: true,
          status: true,
          number: true,
          issueDate: true,
          validityDays: true,
          currency: true,
          taxName: true,
          taxRate: true,
          deliveryTerms: true,
          entitySnapshot: true,
          discountMode: true,
          discountValue: true,
          subtotal: true,
          taxAmount: true,
          total: true,
          showItemPrices: true,
          showOptionPrices: true,
          heroImageUrl: true,
          regionId: true,
          notes: true,
          signingStatus: true,
          signedPdfName: true,
          documentsSnapshot: true,
          deliveryWeeks: true,
          installationDays: true,
          trainingDays: true,
          warrantyMonths: true,
          region: {
            select: {
              entityName: true,
              entityLegalId: true,
              entityAddress: true,
              bankDetails: true,
              logoUrl: true,
              footerText: true,
              deliveryWeeks: true,
              installationDays: true,
              trainingDays: true,
              warrantyMonths: true,
            },
          },
          author: { select: { name: true, email: true, phone: true, image: true } },
          company: {
            select: {
              name: true,
              street: true,
              city: true,
              state: true,
              postcode: true,
              country: true,
              website: true,
              deliverySameAsMain: true,
              deliveryStreet: true,
              deliveryCity: true,
              deliveryState: true,
              deliveryPostcode: true,
              deliveryCountry: true,
              deliveryContactName: true,
              deliveryPhone: true,
              contacts: {
                orderBy: [{ isPrimary: "desc" }, { firstName: "asc" }],
                select: { firstName: true, lastName: true, email: true, phone: true },
              },
            },
          },
          contact: { select: { firstName: true, lastName: true, email: true, phone: true } },
          items: {
            orderBy: { sortOrder: "asc" },
            select: {
              id: true,
              code: true,
              name: true,
              description: true,
              unitPrice: true,
              listPrice: true,
              discountMode: true,
              discountValue: true,
              serialNumber: true,
              imageUrl: true,
              showImage: true,
              lines: {
                orderBy: { sortOrder: "asc" },
                select: {
                  id: true,
                  kind: true,
                  code: true,
                  name: true,
                  description: true,
                  qty: true,
                  unitPrice: true,
                  listPrice: true,
                  attributes: true,
                  refId: true,
                  imageUrl: true,
                  showImage: true,
                },
              },
              product: {
                select: {
                  kind: true,
                  specs: true,
                  isCredit: true,
                  noCommission: true,
                  seriesId: true,
                  series: { select: { name: true, quoteDescription: true } },
                },
              },
            },
          },
          lines: {
            where: { itemId: null },
            orderBy: { sortOrder: "asc" },
            select: {
              id: true,
              kind: true,
              code: true,
              name: true,
              description: true,
              qty: true,
              unitPrice: true,
              listPrice: true,
              attributes: true,
              refId: true,
              imageUrl: true,
              showImage: true,
            },
          },
          signatures: {
            select: { role: true, imageUrl: true, signerName: true, signedAt: true },
          },
          exclusions: { select: { quoteDocumentKey: true } },
        },
      },
    },
  });
  if (!request) return null;

  const document = request.document;

  // Every OPTION line's icon/role/length comes from the option's *current*
  // catalog row, not a snapshot on the line — same live-lookup `optionRowMap`
  // the builder's own document read builds, duplicated here rather than
  // imported because that whole module is off-limits to this file (see the
  // header comment).
  const optionRefIds = Array.from(
    new Set(
      document.items
        .flatMap((item) => item.lines)
        .concat(document.lines)
        .filter((line): line is (typeof document.lines)[number] & { refId: string } => line.kind === "OPTION" && line.refId !== null)
        .map((line) => line.refId)
    )
  );
  const optionRows =
    optionRefIds.length > 0
      ? await db.option.findMany({
          where: { id: { in: optionRefIds } },
          select: { id: true, imageUrl: true, role: true, unitLengthM: true, noCommission: true },
        })
      : [];
  const optionRowMap = new Map<string, OptionRow>(
    optionRows.map((o) => [
      o.id,
      {
        imageUrl: o.imageUrl,
        role: o.role,
        unitLengthM: o.unitLengthM !== null ? Number(o.unitLengthM) : null,
        noCommission: o.noCommission,
      },
    ])
  );

  // Item/document totals are never persisted per row (see DocumentItem /
  // Document in prisma/schema.prisma — there is no `total` or
  // `discountAmount` column on either), so a FINAL document's own totals are
  // recomputed live here, exactly as the builder's own document read does. That is safe
  // — not merely convenient — because every input below (unitPrice,
  // discountValue, lines) is frozen the moment a document leaves DRAFT: no
  // editing action reaches a FINAL row. `EngineInput.commissionTiers` is
  // deliberately left unset: it is optional, and this file has no business
  // asking a salesperson's payout to be computed just because the engine can
  // do both in one pass. Discount eligibility (the one place a no-commission
  // flag changes what the CUSTOMER pays — see `OptionRow.noCommission` above)
  // still flows through via `isNoCommission`.
  const engineInput: EngineInput = {
    items: document.items.map((item) => ({
      unitPrice: Number(item.unitPrice),
      listPrice: item.listPrice !== null ? Number(item.listPrice) : null,
      discountMode: item.discountMode,
      discountValue: item.discountValue !== null ? item.discountValue.toString() : null,
      isCredit: item.product?.isCredit ?? false,
      isNoCommission: item.product?.noCommission ?? false,
      lines: item.lines.map((line) => ({
        qty: line.qty,
        unitPrice: Number(line.unitPrice),
        listPrice: line.listPrice !== null ? Number(line.listPrice) : null,
        isNoCommission: line.refId !== null ? (optionRowMap.get(line.refId)?.noCommission ?? false) : false,
      })),
    })),
    extraLines: document.lines.map((line) => ({ qty: line.qty, unitPrice: Number(line.unitPrice) })),
    documentDiscountMode: document.discountMode,
    documentDiscountValue: document.discountValue !== null ? document.discountValue.toString() : null,
    taxRate: Number(document.taxRate),
  };
  const totals = computeTotals(engineInput);

  const defaultValidityDays = await getQuoteValidityDays();

  const items: QuotationItemInput[] = document.items.map((item, index) => ({
    id: item.id,
    code: item.code,
    name: item.name,
    description: item.description,
    unitPrice: item.unitPrice.toString(),
    listPrice: item.listPrice !== null ? item.listPrice.toString() : null,
    discountMode: item.discountMode,
    discountValue: item.discountValue?.toString() ?? null,
    discountAmount: totals.itemDiscounts[index].toString(),
    total: totals.itemTotals[index].toString(),
    imageUrl: item.imageUrl,
    showImage: item.showImage,
    isCredit: item.product?.isCredit ?? false,
    serialNumber: item.serialNumber,
    kind: item.product?.kind ?? ("ACCESSORY" as ProductKind),
    seriesName: item.product?.series.name ?? null,
    seriesId: item.product?.seriesId ?? null,
    specs: item.product?.specs ?? null,
    seriesQuoteDescription: item.product?.series?.quoteDescription ?? null,
    lines: item.lines.map((line) => toSigningLine(line, optionRowMap)),
  }));

  const company = document.company
    ? {
        name: document.company.name,
        street: document.company.street,
        city: document.company.city,
        state: document.company.state,
        postcode: document.company.postcode,
        country: document.company.country,
        website: document.company.website,
        // Same "flag AND actual data" rule the builder's own document read
        // applies — a company with the flag off but every delivery field
        // still blank has nothing to render as a separate block.
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
      }
    : null;

  const signingDocument: SigningDocument = {
    id: document.id,
    signingStatus: document.signingStatus,
    signedPdfName: document.signedPdfName,
    status: document.status,
    number: document.number,
    issueDate: document.issueDate,
    validityDays: document.validityDays,
    defaultValidityDays,
    currency: document.currency,
    taxName: document.taxName,
    taxRate: document.taxRate.toString(),
    deliveryTerms: document.deliveryTerms,
    entitySnapshot: document.entitySnapshot,
    entityName: document.region.entityName,
    entityLegalId: document.region.entityLegalId,
    entityAddress: document.region.entityAddress,
    bankDetails: document.region.bankDetails,
    logoUrl: document.region.logoUrl,
    footerText: document.region.footerText,
    discountMode: document.discountMode,
    discountValue: document.discountValue?.toString() ?? null,
    subtotal: document.subtotal.toString(),
    discountAmount: totals.discountAmount.toString(),
    taxAmount: document.taxAmount.toString(),
    total: document.total.toString(),
    company,
    contact: document.contact,
    author: {
      name: document.author.name,
      email: document.author.email,
      phone: document.author.phone,
      avatar: document.author.image,
    },
    // The same field the client already receives in the PDF the manager
    // sends — see this file's header comment. Passed through raw, exactly as
    // `documents-builder.ts` does; `buildQuotationData` is what runs it
    // through `renderStoredRichText` to sanitize it into HTML, and the sheet
    // renders no Notes section when it's null, same as any other document.
    notes: document.notes,
    showItemPrices: document.showItemPrices,
    showOptionPrices: document.showOptionPrices,
    heroImageUrl: document.heroImageUrl,
    regionId: document.regionId,
    items,
    extraLines: document.lines.map((line) => toSigningLine(line, optionRowMap)),
    region: {
      deliveryWeeks: document.region.deliveryWeeks,
      installationDays: document.region.installationDays,
      trainingDays: document.region.trainingDays,
      warrantyMonths: document.region.warrantyMonths,
    },
    deliveryWeeks: document.deliveryWeeks,
    installationDays: document.installationDays,
    trainingDays: document.trainingDays,
    warrantyMonths: document.warrantyMonths,
    excludedDocumentKeys: document.exclusions.map((exclusion) => exclusion.quoteDocumentKey),
    documentsSnapshot: document.documentsSnapshot,
    signatures: document.signatures,
  };

  assertNoCommissionLeak(signingDocument);

  return {
    id: request.id,
    expiresAt: request.expiresAt,
    revokedAt: request.revokedAt,
    declinedAt: request.declinedAt,
    firstViewedAt: request.firstViewedAt,
    email: request.email,
    contact: request.contact,
    document: signingDocument,
  };
}
