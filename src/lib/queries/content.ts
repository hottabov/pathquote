import { cache } from "react";
import { db } from "@/lib/db";

export type ContentBlockListItem = {
  key: string;
  title: string | null;
  bodyLength: number;
  /** True when at least one region override (regionId not null) exists for
   * this key — shown as a "Customized per region" badge in the list. */
  hasRegionOverrides: boolean;
};

export type ContentBlockGroup = {
  /** The key prefix before the first "." — e.g. "terms", "option",
   * "software", "equipment", "conditions", "rsp", "machine". Falls back to
   * the full key for any (unexpected) key without a dot. */
  prefix: string;
  blocks: ContentBlockListItem[];
};

/**
 * Every default (regionId:null) content block, grouped by key prefix and
 * ordered within each group by sortOrder then key — mirrors the order
 * they're defined in prisma/seed-data/content-blocks.json. Groups are
 * returned sorted alphabetically by prefix. Each block carries whether any
 * region has an override, so the list page can show a "Customized per
 * region" badge without a per-row query.
 */
export async function listContentBlocks(): Promise<ContentBlockGroup[]> {
  const [defaults, overrideRows] = await Promise.all([
    db.contentBlock.findMany({
      where: { regionId: null },
      orderBy: [{ sortOrder: "asc" }, { key: "asc" }],
    }),
    db.contentBlock.findMany({
      where: { regionId: { not: null } },
      select: { key: true },
      distinct: ["key"],
    }),
  ]);

  const overrideKeys = new Set(overrideRows.map((r) => r.key));

  const groups = new Map<string, ContentBlockListItem[]>();
  for (const block of defaults) {
    const dotIndex = block.key.indexOf(".");
    const prefix = dotIndex > 0 ? block.key.slice(0, dotIndex) : block.key;
    const item: ContentBlockListItem = {
      key: block.key,
      title: block.title,
      bodyLength: block.body.length,
      hasRegionOverrides: overrideKeys.has(block.key),
    };
    const list = groups.get(prefix);
    if (list) list.push(item);
    else groups.set(prefix, [item]);
  }

  return Array.from(groups.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([prefix, blocks]) => ({ prefix, blocks }));
}

export type ContentBlockOverride = {
  regionCode: string;
  title: string | null;
  body: string;
  sortOrder: number;
};

export type ContentBlockActiveRegion = {
  id: string;
  code: string;
  name: string;
};

export type ContentBlockDetail = {
  key: string;
  /** `null` only for a key that was never seeded as a default — the editor
   * page treats that the same as "not found". */
  default: { title: string | null; body: string; sortOrder: number } | null;
  /** Existing region overrides only (not one row per active region — the
   * editor UI shows an empty "create override" state for the rest). */
  overrides: ContentBlockOverride[];
  /** All active regions, for the editor's region tab strip. */
  activeRegions: ContentBlockActiveRegion[];
};

/** A single content block by key: its default (regionId:null) row, every
 * existing region override, and the full list of active regions (so the
 * editor can render a tab for a region that has no override yet). Returns
 * `null` if the key has no default row at all. Request-memoized because the
 * editor page resolves the block in `generateMetadata` (for the tab title)
 * and again in the page body — three queries either way, so the duplicate
 * was the most expensive of the metadata/body pairs in the settings area. */
export const getContentBlock = cache(async function getContentBlock(
  key: string
): Promise<ContentBlockDetail | null> {
  const [defaultBlock, overrideRows, activeRegions] = await Promise.all([
    db.contentBlock.findFirst({ where: { key, regionId: null } }),
    db.contentBlock.findMany({
      where: { key, regionId: { not: null } },
      include: { region: true },
    }),
    db.region.findMany({ where: { active: true }, orderBy: { code: "asc" } }),
  ]);

  if (!defaultBlock) return null;

  // `region` can only be null here if the FK were dangling (never true in
  // practice — Region has no delete path that would orphan a ContentBlock),
  // but guard it anyway rather than asserting non-null.
  const overrides: ContentBlockOverride[] = [];
  for (const row of overrideRows) {
    if (!row.region) continue;
    overrides.push({ regionCode: row.region.code, title: row.title, body: row.body, sortOrder: row.sortOrder });
  }

  return {
    key,
    default: { title: defaultBlock.title, body: defaultBlock.body, sortOrder: defaultBlock.sortOrder },
    overrides,
    activeRegions: activeRegions.map((r) => ({ id: r.id, code: r.code, name: r.name })),
  };
});

// --- quotation rendering ---------------------------------------------------

export type QuotationContentBlockRow = {
  key: string;
  regionId: string | null;
  title: string | null;
  body: string;
  sortOrder: number;
};

/**
 * Every `ContentBlock` row visible when rendering a document in `regionId`
 * — every global default (`regionId: null`) plus every override that
 * belongs to this specific region (a different region's override is never
 * included). Feeds `resolveBlocks` in src/lib/quotation-data.ts, which
 * reduces this flat list down to one row per key (region override wins over
 * default).
 */
export async function getContentBlocksForRegion(regionId: string): Promise<QuotationContentBlockRow[]> {
  const rows = await db.contentBlock.findMany({
    where: { OR: [{ regionId: null }, { regionId }] },
  });

  return rows.map((row) => ({
    key: row.key,
    regionId: row.regionId,
    title: row.title,
    body: row.body,
    sortOrder: row.sortOrder,
  }));
}
