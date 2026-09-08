// The admin Documents list, assembled from the two row sets
// `listQuoteDocuments` reads. Pure: no `@/lib/db`, no `next/*`, so `vitest
// run` needs no DATABASE_URL — the same rule quote-terms.ts and
// quote-variables.ts follow, and the reason the interesting part of this
// query is a function rather than a `.map()` inside it.

/** A `regionId: null` row — the global default every region falls back to. */
export type QuoteDocumentDefaultRow = {
  key: string;
  title: string;
  sortOrder: number;
  includedByDefault: boolean;
};

/** A row belonging to one region. `regionCode` rather than `regionId`
 * because that is what the list actually shows. */
export type QuoteDocumentRegionRow = QuoteDocumentDefaultRow & { regionCode: string };

export type QuoteDocumentListItem = {
  key: string;
  title: string;
  sortOrder: number;
  includedByDefault: boolean;
  /** Region codes (sorted) that have their own version of this document —
   * shown as a "Customised for: US, UK" badge, in place of `ContentBlock`'s
   * plain boolean `hasRegionOverrides` flag: the badge names which regions,
   * not just whether any do. Empty when every region prints the default. */
  regionCodes: string[];
  /** True when NO global default exists for this key — the document prints
   * only in the regions listed in `regionCodes`, and nowhere else. D2's
   * region-only document, e.g. a Data Processing Agreement only an EU entity
   * offers. The list marks these rather than hiding them: while it showed
   * defaults alone, such a document had no screen anywhere that could reach
   * it, and `createRegionVersion` is a supported way to make one. */
  regionOnly: boolean;
};

/**
 * One row per distinct key across both inputs, in print order.
 *
 * A key with a default takes its title, position and default-inclusion from
 * that default — a region's copy may disagree about any of them, and the
 * default is what every region without its own copy actually prints.
 *
 * A key with NO default takes them from one of its region rows, chosen by
 * lowest `sortOrder` then lowest `regionCode`. Nothing constrains two
 * regions' rows for the same key to agree, so picking the first row a
 * `findMany` returned would let the list's title and position change between
 * loads for no reason a reader could see.
 *
 * Ordered by `sortOrder` then `key` — the print order an admin set, with a
 * stable tiebreak, matching what `resolveQuoteDocuments` does when it
 * assembles a quote.
 */
export function buildQuoteDocumentList(
  defaults: QuoteDocumentDefaultRow[],
  regionRows: QuoteDocumentRegionRow[]
): QuoteDocumentListItem[] {
  const regionRowsByKey = new Map<string, QuoteDocumentRegionRow[]>();
  for (const row of regionRows) {
    const rows = regionRowsByKey.get(row.key);
    if (rows) rows.push(row);
    else regionRowsByKey.set(row.key, [row]);
  }

  const items: QuoteDocumentListItem[] = defaults.map((doc) => ({
    key: doc.key,
    title: doc.title,
    sortOrder: doc.sortOrder,
    includedByDefault: doc.includedByDefault,
    regionCodes: codesOf(regionRowsByKey.get(doc.key)),
    regionOnly: false,
  }));

  const defaultKeys = new Set(defaults.map((doc) => doc.key));
  for (const [key, rows] of regionRowsByKey) {
    if (defaultKeys.has(key)) continue;
    const representative = rows.reduce((best, row) =>
      row.sortOrder !== best.sortOrder
        ? row.sortOrder < best.sortOrder
          ? row
          : best
        : row.regionCode < best.regionCode
          ? row
          : best
    );
    items.push({
      key,
      title: representative.title,
      sortOrder: representative.sortOrder,
      includedByDefault: representative.includedByDefault,
      regionCodes: codesOf(rows),
      regionOnly: true,
    });
  }

  return items.sort((a, b) => a.sortOrder - b.sortOrder || a.key.localeCompare(b.key));
}

function codesOf(rows: QuoteDocumentRegionRow[] | undefined): string[] {
  return (rows ?? []).map((row) => row.regionCode).sort();
}
