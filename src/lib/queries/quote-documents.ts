import { cache } from "react";
import { db } from "@/lib/db";
import type { QuoteDocumentRow } from "@/lib/quotation-data";

export type QuoteDocumentListItem = {
  key: string;
  title: string;
  sortOrder: number;
  includedByDefault: boolean;
  /** Region codes (sorted) that have their own version of this document —
   * shown as a "Customised for: US, UK" badge in the admin list, in place of
   * `ContentBlock`'s plain boolean `hasRegionOverrides` flag: the badge names
   * which regions, not just whether any do. Empty when every region prints
   * the default. */
  regionCodes: string[];
};

/**
 * Every default (`regionId: null`) `QuoteDocument`, ordered by `sortOrder`
 * then `key` — the print order an admin set, same ordering rule
 * `listContentBlocks` used. Each document carries which regions have their
 * own version, for the admin list's badge.
 *
 * A document that exists ONLY as a region version — no global default at
 * all (D5: a region-only agreement like an EU entity's Data Processing
 * Agreement, created via `createRegionVersion` with no default to copy) — is
 * not among these rows, exactly as an override-only key never appeared in
 * `listContentBlocks` either. Reaching such a document from the admin list
 * is Task 7's problem, not this query's.
 */
export async function listQuoteDocuments(): Promise<QuoteDocumentListItem[]> {
  const [defaults, overrideRows] = await Promise.all([
    db.quoteDocument.findMany({
      where: { regionId: null },
      orderBy: [{ sortOrder: "asc" }, { key: "asc" }],
    }),
    db.quoteDocument.findMany({
      where: { regionId: { not: null } },
      select: { key: true, region: { select: { code: true } } },
    }),
  ]);

  const regionCodesByKey = new Map<string, string[]>();
  for (const row of overrideRows) {
    // `region` can only be null here if the FK were dangling (never true in
    // practice — Region has no delete path that would orphan a
    // QuoteDocument), but guard it anyway rather than asserting non-null.
    if (!row.region) continue;
    const codes = regionCodesByKey.get(row.key);
    if (codes) codes.push(row.region.code);
    else regionCodesByKey.set(row.key, [row.region.code]);
  }

  return defaults.map((doc) => ({
    key: doc.key,
    title: doc.title,
    sortOrder: doc.sortOrder,
    includedByDefault: doc.includedByDefault,
    regionCodes: (regionCodesByKey.get(doc.key) ?? []).sort(),
  }));
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
 */
export async function getQuoteDocumentsForRegion(regionId: string): Promise<QuoteDocumentRow[]> {
  const rows = await db.quoteDocument.findMany({
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
