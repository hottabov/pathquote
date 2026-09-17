/**
 * A quote revision's snapshot and its content hash, as pure functions over
 * plain values.
 *
 * Two jobs live here, both deliberately free of `@/lib/db` and of any
 * Prisma-generated type so the whole thing is unit-testable without a
 * `prisma generate` (the same reasoning as src/lib/signing/state.ts and
 * src/lib/validation/finalize.ts — the suite has no database, see
 * vitest.config.ts):
 *
 *  1. `buildRevisionSnapshot` projects a finalized quote into a
 *     self-contained, catalogue-independent description of everything the
 *     sheet renders from — items, options, prices, discounts, terms, the
 *     client, the selling entity, and the raw (pre-substitution) legal-document
 *     bodies. "Self-contained" is the point: rendering a revision six months
 *     later must not depend on the live catalogue, the live region, or the
 *     live quote-document text, all of which may have moved on. This mirrors
 *     what `finalizeDocument` already freezes into `Document.entitySnapshot`
 *     and `Document.documentsSnapshot`, but as one addressable object per
 *     revision rather than two columns on the mutable row.
 *
 *  2. `hashRevisionSnapshot` reduces that object to a sha256 of its
 *     canonical (stable-key-order) JSON. The hash is what makes the
 *     "empty revision" guard in the spec work: a manager who unfinalizes and
 *     then re-finalizes without changing anything must NOT burn a new
 *     revision number. `finalizeDocument` compares the fresh snapshot's hash
 *     to the last revision's `snapshotHash`; equal means "nothing changed,
 *     keep the number".
 *
 * For that guard to hold, the snapshot must contain ONLY commercial content
 * and NOTHING that changes on every finalize regardless of edits — no issue
 * date, no `finalizedAt`, no revision number, no display `number`. Those are
 * identity/timestamp, not content; baking any of them in would make every
 * re-finalize hash differently and defeat the dedup entirely. They live on
 * the `QuoteRevision` row's own columns instead (`revision`, `label`,
 * `createdAt`), never inside `snapshot`.
 */
import { createHash } from "node:crypto";

// --- stable stringify --------------------------------------------------------

/**
 * `JSON.stringify` with object keys sorted at every level, so two objects
 * that differ only in key insertion order serialise identically. Arrays are
 * left in order (order is content — reordering line items IS a change).
 * `undefined` object properties are dropped, exactly as `JSON.stringify`
 * already does, so an explicitly-`undefined` field and an absent one hash the
 * same.
 *
 * The input is expected to be plain JSON already (strings, numbers, booleans,
 * null, arrays, objects). Callers converting `Prisma.Decimal` to a canonical
 * 2dp string, and never putting a `Date` in the snapshot, is what keeps this
 * deterministic — see this module's header comment on why timestamps must not
 * be in a snapshot at all.
 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      const canonicalValue = canonicalize(source[key]);
      // Drop `undefined` so it matches JSON.stringify's own behaviour and an
      // absent key hashes identically to an explicitly-undefined one.
      if (canonicalValue !== undefined) out[key] = canonicalValue;
    }
    return out;
  }
  return value;
}

// --- hash --------------------------------------------------------------------

/**
 * sha256 (hex) of the canonical JSON of a revision snapshot. Same primitive
 * as the rest of the app (`node:crypto` `createHash("sha256")`, see
 * src/lib/signing/token.ts and archive.ts) — there is no hashing dependency.
 * Deterministic for equal content regardless of key order; changes for any
 * change in a value or in array order.
 */
export function hashRevisionSnapshot(snapshot: unknown): string {
  return createHash("sha256").update(stableStringify(snapshot), "utf8").digest("hex");
}

// --- snapshot projection -----------------------------------------------------

/** A monetary value carried as a canonical decimal string (e.g. "1234.00"),
 * never a `Prisma.Decimal` or a float — the caller stringifies before it
 * reaches this pure module (see the header comment). */
export type Money = string;

export interface RevisionLineInput {
  itemId: string | null; // null = document-level line
  kind: string; // LineKind
  refId: string | null;
  code: string | null;
  name: string;
  description: string | null;
  qty: number;
  unitPrice: Money;
  listPrice: Money | null;
  attributes: unknown; // Json | null
  showImage: boolean;
  imageUrl: string | null;
  sortOrder: number;
}

export interface RevisionItemInput {
  code: string;
  name: string;
  description: string | null;
  unitPrice: Money;
  listPrice: Money | null;
  discountMode: string;
  discountValue: Money | null;
  serialNumber: string | null;
  showImage: boolean;
  imageUrl: string | null;
  productionSpec: unknown; // Json | null
  sortOrder: number;
  lines: RevisionLineInput[];
}

export interface RevisionEntityInput {
  entityName: string | null;
  entityLegalId: string | null;
  entityAddress: string | null;
  bankDetails: unknown; // Json | null
  logoUrl: string | null;
  footerText: string | null;
  regionCode: string | null;
}

export interface RevisionClientInput {
  companyName: string | null;
  addressLines: string[];
  website: string | null;
  contactFirstName: string | null;
  contactLastName: string | null;
  contactEmail: string | null;
  contactPhone: string | null;
  contactPosition: string | null;
}

export interface RevisionDocumentInput {
  key: string;
  title: string;
  body: string; // RAW body, pre-substitution — the hash must not depend on {{tokens}} resolved against a per-finalize date
}

export interface RevisionSnapshotInput {
  currency: string;
  currencySymbol: string | null;
  taxName: string;
  taxRate: Money;
  deliveryTerms: string;
  discountMode: string;
  discountValue: Money | null;
  subtotal: Money;
  taxAmount: Money;
  total: Money;
  notes: string | null;
  showItemPrices: boolean;
  showOptionPrices: boolean;
  validityDays: number | null;
  deliveryWeeks: number | null;
  installationDays: number | null;
  trainingDays: number | null;
  warrantyMonths: number | null;
  heroImageUrl: string | null;
  client: RevisionClientInput;
  entity: RevisionEntityInput;
  items: RevisionItemInput[];
  documentLines: RevisionLineInput[]; // document-level (itemId === null) lines
  documents: RevisionDocumentInput[]; // included quote-document bodies, raw
}

/** The version stamped into every snapshot. Bump only on a
 * backwards-incompatible change to the projection's shape, so a reader can
 * tell an old snapshot from a new one — and so a shape change alone (which
 * legitimately changes what "the same content" hashes to) is visible in the
 * data rather than silently reshuffling every quote's hash. */
export const REVISION_SNAPSHOT_VERSION = 1 as const;

export interface RevisionSnapshot {
  version: typeof REVISION_SNAPSHOT_VERSION;
  currency: string;
  currencySymbol: string | null;
  taxName: string;
  taxRate: Money;
  deliveryTerms: string;
  discount: { mode: string; value: Money | null };
  totals: { subtotal: Money; taxAmount: Money; total: Money };
  notes: string | null;
  priceDisplay: { showItemPrices: boolean; showOptionPrices: boolean };
  terms: {
    validityDays: number | null;
    deliveryWeeks: number | null;
    installationDays: number | null;
    trainingDays: number | null;
    warrantyMonths: number | null;
  };
  heroImageUrl: string | null;
  client: RevisionClientInput;
  entity: RevisionEntityInput;
  items: RevisionItemInput[];
  documentLines: RevisionLineInput[];
  documents: RevisionDocumentInput[];
}

/**
 * Canonical order for lines within an item (or at document level): by
 * `sortOrder` first (the salesperson's chosen display order — meaningful
 * content), then a stable tiebreak so two rows sharing a sortOrder never let
 * the database's arbitrary return order leak into the hash. `refId` leads the
 * tiebreak because an option/product line always has one; `code` and `name`
 * back it up for a CUSTOM line that has neither.
 */
function sortLines(lines: RevisionLineInput[]): RevisionLineInput[] {
  return [...lines].sort(
    (a, b) =>
      a.sortOrder - b.sortOrder ||
      (a.refId ?? "").localeCompare(b.refId ?? "") ||
      (a.code ?? "").localeCompare(b.code ?? "") ||
      a.name.localeCompare(b.name)
  );
}

/**
 * Projects a finalized quote into its canonical, hashable snapshot. Pure:
 * given equal content it returns an equal object regardless of the order the
 * database handed back items and lines (they are sorted here), and it carries
 * no timestamp, number or id — see the header comment on why the hash must
 * depend on content alone.
 */
export function buildRevisionSnapshot(input: RevisionSnapshotInput): RevisionSnapshot {
  const items = [...input.items]
    .sort((a, b) => a.sortOrder - b.sortOrder || a.code.localeCompare(b.code) || a.name.localeCompare(b.name))
    .map((item) => ({ ...item, lines: sortLines(item.lines) }));

  const documents = [...input.documents].sort((a, b) => a.key.localeCompare(b.key));

  return {
    version: REVISION_SNAPSHOT_VERSION,
    currency: input.currency,
    currencySymbol: input.currencySymbol,
    taxName: input.taxName,
    taxRate: input.taxRate,
    deliveryTerms: input.deliveryTerms,
    discount: { mode: input.discountMode, value: input.discountValue },
    totals: { subtotal: input.subtotal, taxAmount: input.taxAmount, total: input.total },
    notes: input.notes,
    priceDisplay: { showItemPrices: input.showItemPrices, showOptionPrices: input.showOptionPrices },
    terms: {
      validityDays: input.validityDays,
      deliveryWeeks: input.deliveryWeeks,
      installationDays: input.installationDays,
      trainingDays: input.trainingDays,
      warrantyMonths: input.warrantyMonths,
    },
    heroImageUrl: input.heroImageUrl,
    client: input.client,
    entity: input.entity,
    items,
    documentLines: sortLines(input.documentLines),
    documents,
  };
}

/** Convenience: build the snapshot and hash it in one call. The two are kept
 * separate above so a caller that already holds a built snapshot (a reader
 * re-hashing a stored one to verify it, say) doesn't rebuild it. */
export function buildAndHashRevisionSnapshot(input: RevisionSnapshotInput): {
  snapshot: RevisionSnapshot;
  snapshotHash: string;
} {
  const snapshot = buildRevisionSnapshot(input);
  return { snapshot, snapshotHash: hashRevisionSnapshot(snapshot) };
}

// --- mapping a loaded document to a snapshot input ---------------------------
//
// Both `finalizeDocument` and the backfill script need to turn a loaded
// quote (raw Prisma rows, Decimals and all) into a `RevisionSnapshotInput`.
// Doing it in one place stops the two from drifting. Kept pure — decimals are
// accepted as anything with a `toString()` (a `Prisma.Decimal` or a plain
// string), and the already-resolved legal documents are passed in, so this
// module needs no Prisma or quotation-data import and stays in the DB-free
// test suite. The caller is responsible for resolving/filtering the documents
// (resolveQuoteDocuments → includedByDefault && !excluded → sortOrder), which
// is exactly what buildQuotationData does.

/** A decimal as it arrives from Prisma (or a plain string) — anything that
 * stringifies to a canonical 2dp value. */
export type Decimalish = { toString(): string };

export interface DocumentRowForSnapshot {
  currency: string;
  currencySymbol: string | null;
  taxName: string;
  taxRate: Decimalish;
  deliveryTerms: string;
  discountMode: string;
  discountValue: Decimalish | null;
  notes: string | null;
  showItemPrices: boolean;
  showOptionPrices: boolean;
  deliveryWeeks: number | null;
  installationDays: number | null;
  trainingDays: number | null;
  warrantyMonths: number | null;
  heroImageUrl: string | null;
  company: {
    name: string;
    street: string | null;
    city: string | null;
    state: string | null;
    postcode: string | null;
    country: string | null;
    website: string | null;
  } | null;
  contact: {
    firstName: string;
    lastName: string | null;
    email: string | null;
    phone: string | null;
    position: string | null;
  } | null;
  items: DocumentItemRowForSnapshot[];
  lines: DocumentLineRowForSnapshot[]; // document-level (itemId === null)
}

export interface DocumentItemRowForSnapshot {
  code: string;
  name: string;
  description: string | null;
  unitPrice: Decimalish;
  listPrice: Decimalish | null;
  discountMode: string;
  discountValue: Decimalish | null;
  serialNumber: string | null;
  showImage: boolean;
  imageUrl: string | null;
  productionSpec: unknown;
  sortOrder: number;
  lines: DocumentLineRowForSnapshot[];
}

export interface DocumentLineRowForSnapshot {
  itemId: string | null;
  kind: string;
  refId: string | null;
  code: string | null;
  name: string;
  description: string | null;
  qty: number;
  unitPrice: Decimalish;
  listPrice: Decimalish | null;
  attributes: unknown;
  showImage: boolean;
  imageUrl: string | null;
  sortOrder: number;
}

export interface EntityForSnapshot {
  entityName: string | null;
  entityLegalId: string | null;
  entityAddress: string | null;
  bankDetails: unknown;
  logoUrl: string | null;
  footerText: string | null;
  regionCode: string | null;
}

function mapLine(line: DocumentLineRowForSnapshot): RevisionLineInput {
  return {
    itemId: line.itemId,
    kind: line.kind,
    refId: line.refId,
    code: line.code,
    name: line.name,
    description: line.description,
    qty: line.qty,
    unitPrice: line.unitPrice.toString(),
    listPrice: line.listPrice?.toString() ?? null,
    attributes: line.attributes ?? null,
    showImage: line.showImage,
    imageUrl: line.imageUrl,
    sortOrder: line.sortOrder,
  };
}

/** One quote address line built from the client company's parts, skipping the
 * empty ones (city/state/postcode collapse to a single line). */
function clientAddressLines(company: DocumentRowForSnapshot["company"]): string[] {
  if (!company) return [];
  const cityLine = [company.city, company.state, company.postcode]
    .filter((part) => part && part.trim() !== "")
    .join(" ");
  return [company.street, cityLine, company.country].filter(
    (line): line is string => Boolean(line && line.trim() !== "")
  );
}

/**
 * Assembles a `RevisionSnapshotInput` from a loaded document, its frozen
 * entity snapshot, its fresh totals, and its already-resolved legal documents.
 * Pure — see the section comment above.
 */
export function documentToRevisionSnapshotInput(args: {
  document: DocumentRowForSnapshot;
  entity: EntityForSnapshot;
  totals: { subtotal: Decimalish; taxAmount: Decimalish; total: Decimalish };
  validityDays: number | null;
  documents: RevisionDocumentInput[];
}): RevisionSnapshotInput {
  const { document, entity, totals } = args;
  return {
    currency: document.currency,
    currencySymbol: document.currencySymbol,
    taxName: document.taxName,
    taxRate: document.taxRate.toString(),
    deliveryTerms: document.deliveryTerms,
    discountMode: document.discountMode,
    discountValue: document.discountValue?.toString() ?? null,
    subtotal: totals.subtotal.toString(),
    taxAmount: totals.taxAmount.toString(),
    total: totals.total.toString(),
    notes: document.notes,
    showItemPrices: document.showItemPrices,
    showOptionPrices: document.showOptionPrices,
    validityDays: args.validityDays,
    deliveryWeeks: document.deliveryWeeks,
    installationDays: document.installationDays,
    trainingDays: document.trainingDays,
    warrantyMonths: document.warrantyMonths,
    heroImageUrl: document.heroImageUrl,
    client: {
      companyName: document.company?.name ?? null,
      addressLines: clientAddressLines(document.company),
      website: document.company?.website ?? null,
      contactFirstName: document.contact?.firstName ?? null,
      contactLastName: document.contact?.lastName ?? null,
      contactEmail: document.contact?.email ?? null,
      contactPhone: document.contact?.phone ?? null,
      contactPosition: document.contact?.position ?? null,
    },
    entity: {
      entityName: entity.entityName,
      entityLegalId: entity.entityLegalId,
      entityAddress: entity.entityAddress,
      bankDetails: entity.bankDetails ?? null,
      logoUrl: entity.logoUrl,
      footerText: entity.footerText,
      regionCode: entity.regionCode,
    },
    items: document.items.map((item) => ({
      code: item.code,
      name: item.name,
      description: item.description,
      unitPrice: item.unitPrice.toString(),
      listPrice: item.listPrice?.toString() ?? null,
      discountMode: item.discountMode,
      discountValue: item.discountValue?.toString() ?? null,
      serialNumber: item.serialNumber,
      showImage: item.showImage,
      imageUrl: item.imageUrl,
      productionSpec: item.productionSpec ?? null,
      sortOrder: item.sortOrder,
      lines: item.lines.map(mapLine),
    })),
    documentLines: document.lines.map(mapLine),
    documents: args.documents,
  };
}
