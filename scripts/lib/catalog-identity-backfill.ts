import type { PrismaClient } from "@prisma/client";
import { legacyOptionIdentity, legacyProductIdentity } from "../../src/lib/catalog-identity";

/**
 * Fills Product.kind/form/specs/contentBlockKey and Option.role/
 * parentProductId/unitLengthM/contentBlockKey for every catalogue row, by
 * the legacy code rules in src/lib/catalog-identity.ts.
 *
 * Idempotent; safe to re-run. `mode: "missing"` (the seed's choice) leaves
 * rows the admin has already classified alone -- a hand-set kind is
 * information the code rules do not have. `mode: "all"` (the migration
 * script's choice, once) overwrites, which is what a first backfill wants:
 * before z31 every row is at the column defaults and those defaults are
 * wrong for most of them.
 *
 * Returns a report rather than printing, so the seed can fold it into its
 * own output and the tests can assert on it.
 */
export type BackfillReport = {
  products: { total: number; written: number; unresolvedParents: string[] };
  options: { total: number; written: number; unresolvedParents: string[]; blockKeysMissing: string[] };
};

export async function backfillCatalogIdentity(
  db: PrismaClient,
  mode: "missing" | "all" = "missing"
): Promise<BackfillReport> {
  const [products, options, blocks] = await Promise.all([
    db.product.findMany({ include: { series: { select: { code: true } } } }),
    db.option.findMany(),
    db.contentBlock.findMany({ select: { key: true } }),
  ]);
  const blockKeys = new Set(blocks.map((b) => b.key));
  const productIdByCode = new Map(products.map((p) => [p.code, p.id]));

  const report: BackfillReport = {
    products: { total: products.length, written: 0, unresolvedParents: [] },
    options: { total: options.length, written: 0, unresolvedParents: [], blockKeysMissing: [] },
  };

  for (const product of products) {
    // "Already classified" = anything beyond the column default. `kind` is
    // the tell: the default ACCESSORY is the one value the backfill would
    // also produce for a genuine accessory, so a form or specs entry is
    // checked as well before a row is skipped.
    const classified = product.kind !== "ACCESSORY" || product.form !== null || product.specs !== null;
    if (mode === "missing" && classified) continue;

    const identity = legacyProductIdentity(product.series.code, product.code, product.isCredit);
    await db.product.update({
      where: { id: product.id },
      data: {
        kind: identity.kind,
        form: identity.form,
        specs: Object.keys(identity.specs).length ? identity.specs : undefined,
        contentBlockKey:
          identity.contentBlockKey && blockKeys.has(identity.contentBlockKey) ? identity.contentBlockKey : null,
      },
    });
    report.products.written++;
  }

  for (const option of options) {
    const classified = option.role !== null || option.parentProductId !== null || option.unitLengthM !== null;
    if (mode === "missing" && classified) continue;

    const identity = legacyOptionIdentity(option.code);
    const parentProductId = identity.parentProductCode
      ? (productIdByCode.get(identity.parentProductCode) ?? null)
      : null;
    if (identity.parentProductCode && !parentProductId) report.options.unresolvedParents.push(option.code);

    const contentBlockKey = identity.contentBlockKeyCandidates.find((key) => blockKeys.has(key)) ?? null;
    if (!contentBlockKey && identity.role && ROLES_WITH_BLOCKS.has(identity.role)) {
      report.options.blockKeysMissing.push(option.code);
    }

    await db.option.update({
      where: { id: option.id },
      data: {
        role: identity.role,
        parentProductId,
        unitLengthM: identity.unitLengthM,
        contentBlockKey,
      },
    });
    report.options.written++;
  }

  return report;
}

/** Roles the quotation content library has a block for (content-blocks.json). */
const ROLES_WITH_BLOCKS = new Set([
  "OFD",
  "OFP",
  "MTS",
  "IKA",
  "DRG_1",
  "DRG_2",
  "DRG_3",
  "PM",
  "APM",
  "HDC",
  "PRM",
  "BCR",
  "MRK",
  "ABR",
  "DR2",
  "HFV",
  "AFP",
]);
