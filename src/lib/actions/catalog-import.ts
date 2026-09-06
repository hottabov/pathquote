"use server";

import { Prisma } from "@prisma/client";
import { z } from "zod";
import { db } from "@/lib/db";
import { requireAdmin } from "@/lib/authz";
import { recalcDocument } from "@/lib/documents/recalc";
import { sanitizeIfHtml } from "@/lib/rich-text";
import { loadCatalogSnapshot } from "@/lib/queries/catalog-xlsx";
import { revalidateCatalogTree, revalidateDocument, revalidateDocumentList, revalidateImportExport } from "@/lib/revalidate";
import { MAX_IMPORT_BYTES } from "@/lib/catalog-xlsx/columns";
import {
  isCatalogSheets,
  parseCatalogSheets,
  readCatalogWorkbook,
  type CatalogSheets,
  type ImportError,
} from "@/lib/catalog-xlsx/parse";
import { diffCatalog, isNoOpDiff, sameCounts, type CatalogDiff, type DiffCounts } from "@/lib/catalog-xlsx/diff";
import { buildApplyPlan, type ApplyOp, type ItemRef } from "@/lib/catalog-xlsx/apply-plan";

/**
 * Settings -> Import / Export, the import half (plan §3). Two actions, both
 * ADMIN/DEVELOPER only:
 *
 *  - `previewCatalogImport` reads the uploaded .xlsx, validates it against
 *    the live catalogue and returns the diff -- and the raw sheet cells,
 *    which the browser holds on to. Nothing is written, nothing is recorded.
 *  - `applyCatalogImport` takes those cells back and, inside one interactive
 *    transaction, re-reads the catalogue, re-parses, re-diffs and compares
 *    the result's counts with what was previewed. A catalogue edited in the
 *    meantime (by another admin, or by a builder adding a line to a draft)
 *    moves some count and aborts the import, so a stale preview can never be
 *    applied over someone else's change. Only then does it walk the apply
 *    plan, recalculate every draft that lost a line, and write the audit
 *    row -- APPLIED inside the transaction, FAILED outside it if anything
 *    rolled back.
 *
 * Re-running the whole pipeline on confirm is also what makes the cells the
 * client sends back safe to accept: they are just cells, and the server
 * derives every id and every write from them afresh.
 */

export type PreviewResult =
  | { kind: "error"; message: string }
  | { kind: "invalid"; fileName: string; errors: ImportError[] }
  | { kind: "preview"; fileName: string; sheets: CatalogSheets; diff: CatalogDiff };

export type ApplySummary = {
  counts: DiffCounts;
  recalculatedDrafts: number;
};

export type ApplyResult = { kind: "applied"; summary: ApplySummary } | { kind: "error"; message: string };

const XLSX_MIME = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";

function checkFile(file: File): string | null {
  if (file.size === 0) return "The file is empty.";
  if (file.size > MAX_IMPORT_BYTES) return `The file is larger than ${MAX_IMPORT_BYTES / (1024 * 1024)} MB.`;
  if (!/\.xlsx$/i.test(file.name)) return "Only .xlsx workbooks can be imported.";
  // Browsers derive the type from the extension and some send nothing at
  // all, so the extension is the real check; the type is only refused when
  // it is present and clearly something else.
  if (file.type && file.type !== XLSX_MIME && file.type !== "application/octet-stream") {
    return "Only .xlsx workbooks can be imported.";
  }
  return null;
}

export async function previewCatalogImport(formData: FormData): Promise<PreviewResult> {
  await requireAdmin();

  const file = formData.get("file");
  if (!(file instanceof File)) return { kind: "error", message: "Choose an .xlsx file to import." };
  const problem = checkFile(file);
  if (problem) return { kind: "error", message: problem };

  const bytes = new Uint8Array(await file.arrayBuffer());
  const read = readCatalogWorkbook(bytes);
  if (!read.sheets) return { kind: "invalid", fileName: file.name, errors: read.errors };

  const snapshot = await loadCatalogSnapshot();
  const { parsed, errors } = parseCatalogSheets(read.sheets, snapshot);
  if (errors.length > 0) return { kind: "invalid", fileName: file.name, errors };

  const diff = diffCatalog(parsed, snapshot);
  return { kind: "preview", fileName: file.name, sheets: read.sheets, diff };
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

const bucketCountsSchema = z.object({
  unchanged: z.number().int().min(0),
  updated: z.number().int().min(0),
  created: z.number().int().min(0),
  deleted: z.number().int().min(0),
});

const applyInputSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  expectedCounts: z.object({
    products: bucketCountsSchema,
    options: bucketCountsSchema,
    prices: bucketCountsSchema,
    affectedDraftDocuments: z.number().int().min(0),
  }),
  sheets: z.custom<CatalogSheets>(isCatalogSheets, "Invalid sheet data"),
});

export type ApplyInput = z.infer<typeof applyInputSchema>;

/** Thrown inside the transaction to roll it back with a message the admin
 * can act on (as opposed to an unexpected failure, which is reported
 * generically and logged). */
class ImportAbort extends Error {}

const STALE_PREVIEW =
  "The catalogue has changed since this preview was made, so nothing was imported. Upload the file again to see a fresh preview.";

export async function applyCatalogImport(input: ApplyInput): Promise<ApplyResult> {
  const session = await requireAdmin();

  const parsedInput = applyInputSchema.safeParse(input);
  if (!parsedInput.success) return { kind: "error", message: "Invalid import data -- upload the file again." };
  const { fileName, expectedCounts, sheets } = parsedInput.data;

  let attemptedDiff: CatalogDiff | null = null;
  try {
    const summary = await db.$transaction(
      async (tx) => {
        const snapshot = await loadCatalogSnapshot(tx);
        const { parsed, errors } = parseCatalogSheets(sheets, snapshot);
        if (errors.length > 0) throw new ImportAbort(STALE_PREVIEW);
        const diff = diffCatalog(parsed, snapshot);
        attemptedDiff = diff;
        if (!sameCounts(diff.counts, expectedCounts)) throw new ImportAbort(STALE_PREVIEW);
        if (isNoOpDiff(diff)) throw new ImportAbort("The file matches the catalogue exactly -- there is nothing to import.");

        const plan = buildApplyPlan(diff, parsed);
        const executor = new PlanExecutor(tx, snapshot, parsed.products);
        for (const op of plan) await executor.run(op);

        const affected = [...executor.affectedDraftIds];
        for (const documentId of affected) await recalcDocument(documentId, tx);

        await tx.catalogImport.create({
          data: {
            userId: session.user.id,
            fileName,
            status: "APPLIED",
            counts: diff.counts as Prisma.InputJsonValue,
            diff: diff as unknown as Prisma.InputJsonValue,
          },
        });

        return { counts: diff.counts, recalculatedDrafts: affected.length, affected };
      },
      // A catalogue-sized import is a few hundred statements plus a recalc
      // per touched draft; the defaults (2s wait / 5s run) are for a handful.
      { maxWait: 10_000, timeout: 120_000 }
    );

    revalidateCatalogTree();
    revalidateDocumentList();
    for (const documentId of summary.affected) revalidateDocument(documentId);
    revalidateImportExport();
    return { kind: "applied", summary: { counts: summary.counts, recalculatedDrafts: summary.recalculatedDrafts } };
  } catch (error) {
    const message =
      error instanceof ImportAbort
        ? error.message
        : error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002"
          ? "A code in the file collides with an existing one, so nothing was imported."
          : "The import failed and was rolled back -- nothing was changed.";
    if (!(error instanceof ImportAbort)) console.error("catalog import failed", error);
    await db.catalogImport.create({
      data: {
        userId: session.user.id,
        fileName,
        status: "FAILED",
        error: error instanceof Error ? error.message : String(error),
        counts: ((attemptedDiff as CatalogDiff | null)?.counts ?? expectedCounts) as Prisma.InputJsonValue,
        diff: ((attemptedDiff as CatalogDiff | null) ?? {}) as unknown as Prisma.InputJsonValue,
      },
    });
    revalidateImportExport();
    return { kind: "error", message };
  }
}

// ---------------------------------------------------------------------------
// Executor: one ApplyOp -> one or two Prisma statements
// ---------------------------------------------------------------------------

type Snapshot = Awaited<ReturnType<typeof loadCatalogSnapshot>>;

/** `Product.description` is stored as sanitized HTML (see updateProduct in
 * src/lib/actions/catalog/products.ts); a description typed into Excel goes
 * through the same sanitizer rather than around it. */
function cleanDescription(description: string | null): string | null {
  return description === null ? null : sanitizeIfHtml(description);
}

class PlanExecutor {
  readonly affectedDraftIds = new Set<string>();
  private readonly seriesIdByCode: Map<string, string>;
  private readonly regionIdByCode = new Map<string, string>();
  /** Product code (as it stands in the file) -> id, grown as creates run. */
  private readonly productIdByCode: Map<string, string>;
  private readonly optionIdByCode = new Map<string, string>();

  constructor(
    private readonly tx: Prisma.TransactionClient,
    snapshot: Snapshot,
    fileProducts: { id: string | null; code: string }[]
  ) {
    this.seriesIdByCode = new Map(snapshot.series.map((s) => [s.code, s.id]));
    this.productIdByCode = new Map(
      fileProducts.filter((p): p is { id: string; code: string } => p.id !== null).map((p) => [p.code, p.id])
    );
  }

  private async regionId(code: string): Promise<string> {
    const cached = this.regionIdByCode.get(code);
    if (cached) return cached;
    const region = await this.tx.region.findUnique({ where: { code }, select: { id: true } });
    if (!region) throw new ImportAbort(`Region "${code}" no longer exists.`);
    this.regionIdByCode.set(code, region.id);
    return region.id;
  }

  private resolve(ref: ItemRef, itemType: "product" | "option"): string {
    if ("id" in ref) return ref.id;
    const id = (itemType === "product" ? this.productIdByCode : this.optionIdByCode).get(ref.newCode);
    if (!id) throw new Error(`catalog import: ${itemType} "${ref.newCode}" was not created before it was referenced`);
    return id;
  }

  private productId(code: string | null): string | null {
    if (code === null) return null;
    const id = this.productIdByCode.get(code);
    if (!id) throw new Error(`catalog import: product "${code}" is not in the file`);
    return id;
  }

  private seriesId(code: string): string {
    const id = this.seriesIdByCode.get(code);
    if (!id) throw new ImportAbort(`Series "${code}" no longer exists.`);
    return id;
  }

  async run(op: ApplyOp): Promise<void> {
    const tx = this.tx;
    switch (op.op) {
      case "detachDraftReferences": {
        // Lines first (an OPTION line, or a PRODUCT line, pointing at the
        // row), then -- for a product -- the draft items themselves, whose
        // own lines cascade. Only DRAFT documents; FINAL ones keep their
        // snapshots and their (soon nulled) link.
        const draft = { document: { status: "DRAFT" as const } };
        const lines = await tx.documentLine.findMany({ where: { refId: op.id, ...draft }, select: { documentId: true } });
        for (const l of lines) this.affectedDraftIds.add(l.documentId);
        await tx.documentLine.deleteMany({ where: { refId: op.id, ...draft } });
        if (op.itemType === "product") {
          const items = await tx.documentItem.findMany({ where: { productId: op.id, ...draft }, select: { documentId: true } });
          for (const i of items) this.affectedDraftIds.add(i.documentId);
          await tx.documentItem.deleteMany({ where: { productId: op.id, ...draft } });
        }
        return;
      }
      case "deleteOption":
        await tx.option.delete({ where: { id: op.id } });
        return;
      case "deleteProduct":
        await tx.product.delete({ where: { id: op.id } });
        return;
      case "releaseCode": {
        // A transient value unique per row; overwritten by the update that
        // follows in the same transaction.
        const code = `__import__${op.id}`;
        if (op.itemType === "product") await tx.product.update({ where: { id: op.id }, data: { code } });
        else await tx.option.update({ where: { id: op.id }, data: { code } });
        return;
      }
      case "createProduct": {
        const d = op.data;
        const created = await tx.product.create({
          data: {
            code: d.code,
            seriesId: this.seriesId(d.series),
            name: d.name,
            description: cleanDescription(d.description),
            kind: d.kind,
            form: d.form,
            ...(d.specs !== null ? { specs: d.specs as Prisma.InputJsonValue } : {}),
            contentBlockKey: d.contentBlockKey,
            isCredit: d.isCredit,
            noCommission: d.noCommission,
            active: d.active,
            sortOrder: d.sortOrder,
            imageUrl: d.imageUrl,
          },
          select: { id: true },
        });
        this.productIdByCode.set(op.code, created.id);
        return;
      }
      case "updateProduct": {
        const d = op.data;
        await tx.product.update({
          where: { id: op.id },
          data: {
            code: d.code,
            seriesId: this.seriesId(d.series),
            name: d.name,
            description: cleanDescription(d.description),
            kind: d.kind,
            form: d.form,
            specs: d.specs === null ? Prisma.DbNull : (d.specs as Prisma.InputJsonValue),
            contentBlockKey: d.contentBlockKey,
            isCredit: d.isCredit,
            noCommission: d.noCommission,
            active: d.active,
            sortOrder: d.sortOrder,
            imageUrl: d.imageUrl,
          },
        });
        // A renamed product must resolve by its new code for the options
        // that follow (parentProduct, compatProducts).
        this.productIdByCode.set(d.code, op.id);
        return;
      }
      case "createOption": {
        const d = op.data;
        const created = await tx.option.create({
          data: {
            code: d.code,
            name: d.name,
            shortDescription: d.shortDescription,
            role: d.role,
            parentProductId: this.productId(d.parentProduct),
            unitLengthM: d.unitLengthM === null ? null : new Prisma.Decimal(d.unitLengthM),
            contentBlockKey: d.contentBlockKey,
            noCommission: d.noCommission,
            active: d.active,
            sortOrder: d.sortOrder,
            imageUrl: d.imageUrl,
            ...(d.attributeSchema != null ? { attributeSchema: d.attributeSchema as Prisma.InputJsonValue } : {}),
          },
          select: { id: true },
        });
        this.optionIdByCode.set(op.code, created.id);
        return;
      }
      case "updateOption": {
        const d = op.data;
        await tx.option.update({
          where: { id: op.id },
          data: {
            code: d.code,
            name: d.name,
            shortDescription: d.shortDescription,
            role: d.role,
            parentProductId: this.productId(d.parentProduct),
            unitLengthM: d.unitLengthM === null ? null : new Prisma.Decimal(d.unitLengthM),
            contentBlockKey: d.contentBlockKey,
            noCommission: d.noCommission,
            active: d.active,
            sortOrder: d.sortOrder,
            imageUrl: d.imageUrl,
            attributeSchema: d.attributeSchema == null ? Prisma.DbNull : (d.attributeSchema as Prisma.InputJsonValue),
          },
        });
        return;
      }
      case "replaceOptionCompat": {
        const optionId = this.resolve(op.option, "option");
        await tx.optionCompatibility.deleteMany({ where: { optionId } });
        const rows = [
          ...op.compatSeries.map((code) => ({ optionId, seriesId: this.seriesId(code) })),
          ...op.compatProducts.map((code) => ({ optionId, productId: this.productId(code)! })),
        ];
        if (rows.length > 0) await tx.optionCompatibility.createMany({ data: rows });
        return;
      }
      case "upsertPrice": {
        const regionId = await this.regionId(op.region);
        const amount = new Prisma.Decimal(op.amount);
        const itemId = this.resolve(op.item, op.itemType);
        if (op.itemType === "product") {
          await tx.price.upsert({
            where: { productId_regionId: { productId: itemId, regionId } },
            create: { productId: itemId, regionId, amount, needsReview: op.needsReview },
            update: { amount, needsReview: op.needsReview },
          });
        } else {
          await tx.price.upsert({
            where: { optionId_regionId: { optionId: itemId, regionId } },
            create: { optionId: itemId, regionId, amount, needsReview: op.needsReview },
            update: { amount, needsReview: op.needsReview },
          });
        }
        return;
      }
      case "deletePrice": {
        const regionId = await this.regionId(op.region);
        const itemId = this.resolve(op.item, op.itemType);
        await tx.price.deleteMany({
          where: op.itemType === "product" ? { productId: itemId, regionId } : { optionId: itemId, regionId },
        });
        return;
      }
    }
  }
}
