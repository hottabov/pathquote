import { cache } from "react";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import type { QuoteDocumentRow } from "@/lib/quotation-data";
import {
  buildQuoteDocumentList,
  type QuoteDocumentRegionRow,
} from "@/lib/quote-document-list";

export type { QuoteDocumentListItem } from "@/lib/quote-document-list";

/**
 * Every quote document there is, ordered by `sortOrder` then `key` — the
 * print order an admin set. Each carries which regions keep their own
 * version, for the list's badge.
 *
 * Both row sets are read, not just the defaults: a document may exist ONLY
 * as a region version, with no global default at all (D2's region-only
 * agreement — an EU entity's Data Processing Agreement, say, created through
 * `createRegionVersion`, which deliberately works with nothing to copy).
 * While this returned defaults alone, such a document was invisible here,
 * which meant the only screen that can edit or delete it could not be
 * reached — and, worse, the drag list built from these rows was then a
 * strict subset of the keys `reorderQuoteDocuments` checks against, so the
 * first region-only document broke reordering for every document at once.
 *
 * The assembly itself is `buildQuoteDocumentList`, kept pure in
 * src/lib/quote-document-list.ts so that rule can be tested without a
 * database.
 */
export async function listQuoteDocuments() {
  const [defaults, overrideRows] = await Promise.all([
    db.quoteDocument.findMany({ where: { regionId: null } }),
    db.quoteDocument.findMany({
      where: { regionId: { not: null } },
      select: {
        key: true,
        title: true,
        sortOrder: true,
        includedByDefault: true,
        region: { select: { code: true } },
      },
    }),
  ]);

  const regionRows: QuoteDocumentRegionRow[] = [];
  for (const row of overrideRows) {
    // `region` can only be null here if the FK were dangling (never true in
    // practice — Region has no delete path that would orphan a
    // QuoteDocument), but guard it anyway rather than asserting non-null.
    if (!row.region) continue;
    regionRows.push({
      key: row.key,
      regionCode: row.region.code,
      title: row.title,
      sortOrder: row.sortOrder,
      includedByDefault: row.includedByDefault,
    });
  }

  return buildQuoteDocumentList(defaults, regionRows);
}

export type QuoteDocumentOverride = {
  regionCode: string;
  title: string;
  body: string;
  sortOrder: number;
  includedByDefault: boolean;
};

export type QuoteDocumentActiveRegion = {
  id: string;
  code: string;
  name: string;
};

export type QuoteDocumentDetail = {
  key: string;
  /** `null` for a key with no global default at all — a region-only
   * document (D5). The editor page treats that as "no default tab", not as
   * "not found": `overrides` still carries the region version(s) that DO
   * exist. Unlike `ContentBlockDetail`, `null` here is a real, supported
   * state rather than one the caller collapses to "not found" — see this
   * function's own `null` return below for the actual "not found" case. */
  default: { title: string; body: string; sortOrder: number; includedByDefault: boolean } | null;
  /** Existing region versions only (not one row per active region — the
   * editor UI shows an empty "create version" state for the rest). */
  overrides: QuoteDocumentOverride[];
  /** All active regions, for the editor's region tab strip. */
  activeRegions: QuoteDocumentActiveRegion[];
};

/**
 * A single quote document by key: its default (`regionId: null`) row, every
 * existing region version, and the full list of active regions (so the
 * editor can render a tab for a region that has no version yet). Returns
 * `null` only when the key names NOTHING at all — no default and no region
 * version either; a region-only document (default `null`, `overrides`
 * non-empty) is a real result, not this `null`.
 *
 * Request-memoized for the same reason `getContentBlock` was: the editor
 * page resolves the document in `generateMetadata` (for the tab title) and
 * again in the page body.
 */
export const getQuoteDocument = cache(async function getQuoteDocument(
  key: string
): Promise<QuoteDocumentDetail | null> {
  const [defaultDoc, overrideRows, activeRegions] = await Promise.all([
    db.quoteDocument.findFirst({ where: { key, regionId: null } }),
    db.quoteDocument.findMany({
      where: { key, regionId: { not: null } },
      include: { region: true },
    }),
    db.region.findMany({ where: { active: true }, orderBy: { code: "asc" } }),
  ]);

  if (!defaultDoc && overrideRows.length === 0) return null;

  const overrides: QuoteDocumentOverride[] = [];
  for (const row of overrideRows) {
    if (!row.region) continue;
    overrides.push({
      regionCode: row.region.code,
      title: row.title,
      body: row.body,
      sortOrder: row.sortOrder,
      includedByDefault: row.includedByDefault,
    });
  }

  return {
    key,
    default: defaultDoc
      ? {
          title: defaultDoc.title,
          body: defaultDoc.body,
          sortOrder: defaultDoc.sortOrder,
          includedByDefault: defaultDoc.includedByDefault,
        }
      : null,
    overrides,
    activeRegions: activeRegions.map((r) => ({ id: r.id, code: r.code, name: r.name })),
  };
});

// --- quotation rendering -----------------------------------------------

/**
 * Every `QuoteDocument` row visible when rendering a document in `regionId`
 * — every global default (`regionId: null`) plus every version that belongs
 * to this specific region (a different region's version is never included).
 * Feeds `resolveQuoteDocuments` in src/lib/quotation-data.ts, which reduces
 * this flat list down to one row per key (region version wins over
 * default). Mirrors `getContentBlocksForRegion`, the query this replaces.
 *
 * `tx` exists for `finalizeDocument`, which resolves these rows inside the
 * transaction that flips the quote to FINAL so the text it freezes and the
 * totals it freezes come from one consistent read — the same reason
 * `getDocumentForBuilder` and `getCommissionTiers` take one. Every other
 * caller omits it and goes through the `db` singleton.
 */
export async function getQuoteDocumentsForRegion(
  regionId: string,
  tx?: Prisma.TransactionClient
): Promise<QuoteDocumentRow[]> {
  const rows = await (tx ?? db).quoteDocument.findMany({
    where: { OR: [{ regionId: null }, { regionId }] },
  });

  return rows.map((row) => ({
    key: row.key,
    regionId: row.regionId,
    title: row.title,
    body: row.body,
    sortOrder: row.sortOrder,
    includedByDefault: row.includedByDefault,
  }));
}
