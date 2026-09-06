import { db } from "@/lib/db";
import type { Prisma } from "@prisma/client";
import type { CatalogSnapshot, ReferenceCounts } from "@/lib/catalog-xlsx/snapshot";

/**
 * The catalogue as a plain snapshot for the workbook engine
 * (src/lib/catalog-xlsx/*): what the export writes and what the import diffs
 * against. Read through `client` so the import can take it *inside* its
 * transaction (a read on the `db` singleton from inside an interactive
 * transaction sees a different snapshot and holds a second pool connection
 * -- same rule `RecalcClient` states in src/lib/documents/recalc.ts).
 */
export type SnapshotClient = Pick<
  Prisma.TransactionClient,
  "region" | "series" | "product" | "option" | "documentItem" | "documentLine"
>;

export async function loadCatalogSnapshot(client: SnapshotClient = db): Promise<CatalogSnapshot> {
  const [regions, series, products, options, refs] = await Promise.all([
    client.region.findMany({ orderBy: { code: "asc" } }),
    client.series.findMany({ orderBy: { sortOrder: "asc" } }),
    client.product.findMany({
      include: { series: true, prices: { include: { region: true } } },
    }),
    client.option.findMany({
      include: {
        parentProduct: true,
        prices: { include: { region: true } },
        compat: { include: { series: true, product: true } },
      },
    }),
    loadReferenceCounts(client),
  ]);

  const priceMap = (prices: { region: { code: string }; amount: { toString(): string }; needsReview: boolean }[]) =>
    Object.fromEntries(prices.map((pr) => [pr.region.code, { amount: pr.amount.toString(), needsReview: pr.needsReview }]));

  return {
    generatedAt: new Date().toISOString(),
    regions: regions.map((r) => ({ code: r.code, name: r.name, currency: r.currency })),
    series: series.map((s) => ({ id: s.id, code: s.code, name: s.name, sortOrder: s.sortOrder })),
    products: products.map((p) => ({
      id: p.id,
      code: p.code,
      series: p.series.code,
      name: p.name,
      description: p.description,
      kind: p.kind,
      form: p.form,
      specs: p.specs,
      contentBlockKey: p.contentBlockKey,
      isCredit: p.isCredit,
      noCommission: p.noCommission,
      active: p.active,
      sortOrder: p.sortOrder,
      imageUrl: p.imageUrl,
      prices: priceMap(p.prices),
      refs: refs.get(p.id) ?? { draftDocumentIds: [], finalDocuments: 0 },
    })),
    options: options.map((o) => ({
      id: o.id,
      code: o.code,
      name: o.name,
      shortDescription: o.shortDescription,
      role: o.role,
      parentProduct: o.parentProduct?.code ?? null,
      unitLengthM: o.unitLengthM === null ? null : o.unitLengthM.toString(),
      compatSeries: o.compat.filter((c) => c.series).map((c) => c.series!.code),
      compatProducts: o.compat.filter((c) => c.product).map((c) => c.product!.code),
      contentBlockKey: o.contentBlockKey,
      noCommission: o.noCommission,
      active: o.active,
      sortOrder: o.sortOrder,
      imageUrl: o.imageUrl,
      attributeSchema: o.attributeSchema,
      prices: priceMap(o.prices),
      refs: refs.get(o.id) ?? { draftDocumentIds: [], finalDocuments: 0 },
    })),
  };
}

/**
 * Which documents reference each catalogue row, keyed by product/option id:
 * a product through `DocumentItem.productId` (and a PRODUCT line's `refId`),
 * an option through an OPTION line's `refId`. Ids are cuids, so one map can
 * hold both kinds without collision. Draft ids are kept (not just counted)
 * so the diff can report distinct affected drafts across many deletions.
 */
async function loadReferenceCounts(client: SnapshotClient): Promise<Map<string, ReferenceCounts>> {
  const [items, lines] = await Promise.all([
    client.documentItem.findMany({
      where: { productId: { not: null } },
      select: { productId: true, documentId: true, document: { select: { status: true } } },
      distinct: ["productId", "documentId"],
    }),
    client.documentLine.findMany({
      where: { refId: { not: null } },
      select: { refId: true, documentId: true, document: { select: { status: true } } },
      distinct: ["refId", "documentId"],
    }),
  ]);

  const drafts = new Map<string, Set<string>>();
  const finals = new Map<string, Set<string>>();
  const note = (id: string, documentId: string, status: string) => {
    const map = status === "FINAL" ? finals : drafts;
    let set = map.get(id);
    if (!set) map.set(id, (set = new Set()));
    set.add(documentId);
  };
  for (const item of items) note(item.productId!, item.documentId, item.document.status);
  for (const line of lines) note(line.refId!, line.documentId, line.document.status);

  const out = new Map<string, ReferenceCounts>();
  for (const id of new Set([...drafts.keys(), ...finals.keys()])) {
    out.set(id, {
      draftDocumentIds: [...(drafts.get(id) ?? [])],
      finalDocuments: finals.get(id)?.size ?? 0,
    });
  }
  return out;
}

export type CatalogImportHistoryItem = {
  id: string;
  createdAt: Date;
  user: { name: string | null; email: string };
  fileName: string;
  status: "APPLIED" | "FAILED";
  error: string | null;
  counts: unknown;
};

/** The most recent imports, newest first -- the history list on Settings -> Import / Export. */
export async function listCatalogImports(limit = 10): Promise<CatalogImportHistoryItem[]> {
  const rows = await db.catalogImport.findMany({
    orderBy: { createdAt: "desc" },
    take: limit,
    select: {
      id: true,
      createdAt: true,
      fileName: true,
      status: true,
      error: true,
      counts: true,
      user: { select: { name: true, email: true } },
    },
  });
  return rows;
}
