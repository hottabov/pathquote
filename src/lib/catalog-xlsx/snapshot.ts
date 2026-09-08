/**
 * The catalogue as the workbook code sees it: a plain, JSON-shaped snapshot
 * that the query layer (src/lib/queries/catalog-xlsx.ts) reads out of Prisma
 * and that both the export builder (./export.ts) and the import diff
 * (./diff.ts) consume. Nothing here imports Prisma -- the shape is what lets
 * the whole engine be tested against a JSON dump.
 */

export type ExportPrice = {
  /** Decimal as string ("1950.00") or number; converted to a number cell. */
  amount: string | number;
  needsReview: boolean;
};

export type ExportRegion = { code: string; name: string; currency: string };

export type ExportSeries = { id: string; code: string; name: string; sortOrder: number };

export type ExportProduct = {
  id: string;
  code: string;
  /** Series.code */
  series: string;
  name: string;
  description: string | null;
  kind: string;
  form: string | null;
  specs: unknown;
  isCredit: boolean;
  noCommission: boolean;
  active: boolean;
  sortOrder: number;
  imageUrl: string | null;
  /** keyed by Region.code */
  prices: Record<string, ExportPrice>;
};

export type ExportOption = {
  id: string;
  code: string;
  name: string;
  shortDescription: string | null;
  role: string | null;
  /** Product.code of the owning product, or null */
  parentProduct: string | null;
  unitLengthM: string | number | null;
  compatSeries: string[];
  compatProducts: string[];
  noCommission: boolean;
  active: boolean;
  sortOrder: number;
  imageUrl: string | null;
  attributeSchema: unknown;
  prices: Record<string, ExportPrice>;
};

/** What the export builder needs. */
export type CatalogExportSnapshot = {
  /** ISO timestamp; printed in the README sheet. */
  generatedAt: string;
  regions: ExportRegion[];
  series: ExportSeries[];
  products: ExportProduct[];
  options: ExportOption[];
};

/**
 * Which documents still point at a catalogue row -- what the import preview
 * shows beside every deletion. A DRAFT reference is a line the import will
 * remove (and a document it will recalculate); a FINAL reference is shown
 * only as reassurance, since finalized documents are never touched (their
 * items are snapshots -- see DocumentItem in prisma/schema.prisma).
 *
 * Draft ids rather than a count so the diff can report how many *distinct*
 * drafts a whole import touches: two deleted rows on the same draft are one
 * document to recalculate, not two.
 */
export type ReferenceCounts = {
  draftDocumentIds: string[];
  finalDocuments: number;
};

export type SnapshotProduct = ExportProduct & { refs: ReferenceCounts };
export type SnapshotOption = ExportOption & { refs: ReferenceCounts };

/** The export snapshot plus reference counts -- what the import diff needs.
 * Structurally a `CatalogExportSnapshot` too, so one query serves both. */
export type CatalogSnapshot = Omit<CatalogExportSnapshot, "products" | "options"> & {
  products: SnapshotProduct[];
  options: SnapshotOption[];
};

export const NO_REFERENCES: ReferenceCounts = { draftDocumentIds: [], finalDocuments: 0 };
