import "dotenv/config";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Prisma, type PrismaClient } from "@prisma/client";
import {
  type CatalogSnapshot,
  type CatalogTarget,
  type Operation,
  PlanError,
  planCatalogV2,
  renderOperation,
  renderSummary,
} from "./lib/catalog-v2-plan";

/**
 * Applies docs/reference/catalog-v2-target.json to the live catalogue --
 * phase 3 of docs/plans/2026-09-05-catalog-identity-and-cleanup.md.
 *
 *   npx tsx scripts/migrate-catalog-v2.ts --dry-run   # print the diff, write nothing
 *   npx tsx scripts/migrate-catalog-v2.ts             # apply, in one transaction
 *
 * The plan is computed by scripts/lib/catalog-v2-plan.ts (pure, tested
 * against RAW/catalog-dump.json); this file reads the snapshot, prints or
 * applies the operations, and prints a summary. Idempotent: a second run
 * plans zero operations, because every row is matched by id or by any code
 * it has ever had (`legacyCodes`).
 *
 * Order of writes: products (update/create), options (update/create,
 * compatibility, prices), product prices, then deletes -- options first,
 * then products. Deleting a product nulls DocumentItem.productId (optional
 * relation, default SetNull) and cascades its prices and visibility rows;
 * DocumentLine.refId is a plain string and is left alone (documents keep
 * their frozen snapshot). Content-block keys are not touched: renamed rows
 * keep the one the identity backfill gave them, and none of the added rows
 * has a block.
 */

type Tx = Prisma.TransactionClient | PrismaClient;

async function readSnapshot(db: Tx): Promise<CatalogSnapshot> {
  const [series, products, options] = await Promise.all([
    db.series.findMany({ select: { code: true } }),
    db.product.findMany({ include: { series: true, prices: { include: { region: true } } } }),
    db.option.findMany({
      include: {
        parentProduct: { select: { code: true } },
        prices: { include: { region: true } },
        compat: { include: { series: true, product: true } },
      },
    }),
  ]);
  const prices = (rows: { region: { code: string }; amount: Prisma.Decimal; needsReview: boolean }[]) =>
    Object.fromEntries(rows.map((p) => [p.region.code, { amount: p.amount.toNumber(), needsReview: p.needsReview }]));
  return {
    series,
    products: products.map((p) => ({
      id: p.id,
      code: p.code,
      legacyCodes: p.legacyCodes,
      series: p.series.code,
      name: p.name,
      description: p.description,
      specs: p.specs,
      isCredit: p.isCredit,
      noCommission: p.noCommission,
      kind: p.kind,
      form: p.form,
      prices: prices(p.prices),
    })),
    options: options.map((o) => ({
      id: o.id,
      code: o.code,
      legacyCodes: o.legacyCodes,
      name: o.name,
      shortDescription: o.shortDescription,
      noCommission: o.noCommission,
      role: o.role,
      parentProductCode: o.parentProduct?.code ?? null,
      unitLengthM: o.unitLengthM === null ? null : o.unitLengthM.toNumber(),
      compatSeries: o.compat.flatMap((c) => (c.series ? [c.series.code] : [])),
      compatProducts: o.compat.flatMap((c) => (c.product ? [c.product.code] : [])),
      prices: prices(o.prices),
    })),
  };
}

async function apply(tx: Tx, operations: Operation[]) {
  const [seriesRows, regionRows, productRows, optionRows] = await Promise.all([
    tx.series.findMany({ select: { id: true, code: true } }),
    tx.region.findMany({ select: { id: true, code: true } }),
    tx.product.findMany({ select: { id: true, code: true, seriesId: true, sortOrder: true } }),
    tx.option.findMany({ select: { id: true, code: true, sortOrder: true } }),
  ]);
  const seriesId = new Map(seriesRows.map((s) => [s.code, s.id]));
  const regionId = new Map(regionRows.map((r) => [r.code, r.id]));
  const productIdByCode = new Map(productRows.map((p) => [p.code, p.id]));
  const optionIdByCode = new Map(optionRows.map((o) => [o.code, o.id]));
  const maxProductSort = new Map<string, number>();
  for (const p of productRows) maxProductSort.set(p.seriesId, Math.max(maxProductSort.get(p.seriesId) ?? -1, p.sortOrder));
  let maxOptionSort = Math.max(-1, ...optionRows.map((o) => o.sortOrder));

  const need = <T>(map: Map<string, T>, key: string, what: string): T => {
    const v = map.get(key);
    if (v === undefined) throw new Error(`${what} ${JSON.stringify(key)} not found`);
    return v;
  };
  const byOp = <K extends Operation["op"]>(op: K) => operations.filter((o): o is Extract<Operation, { op: K }> => o.op === op);

  // (a) products
  for (const o of byOp("product.update")) {
    const c = o.changes;
    await tx.product.update({
      where: { id: o.id },
      data: {
        code: c.code?.to,
        legacyCodes: c.legacyCodes?.to,
        seriesId: c.seriesCode ? need(seriesId, c.seriesCode.to, "series") : undefined,
        name: c.name?.to,
        description: c.description?.to,
        kind: c.kind?.to,
        form: c.form?.to,
        specs: c.specs ? ((c.specs.to ?? Prisma.DbNull) as Prisma.InputJsonValue | typeof Prisma.DbNull) : undefined,
        isCredit: c.isCredit?.to,
        noCommission: c.noCommission?.to,
      },
    });
    if (c.code) {
      productIdByCode.delete(c.code.from ?? "");
      productIdByCode.set(c.code.to, o.id);
    }
  }
  for (const o of byOp("product.create")) {
    const sid = need(seriesId, o.data.seriesCode, "series");
    const sortOrder = (maxProductSort.get(sid) ?? -1) + 1;
    maxProductSort.set(sid, sortOrder);
    const created = await tx.product.create({
      data: {
        code: o.data.code,
        legacyCodes: o.data.legacyCodes,
        seriesId: sid,
        name: o.data.name,
        description: o.data.description,
        kind: o.data.kind,
        form: o.data.form,
        specs: (o.data.specs ?? undefined) as Prisma.InputJsonValue | undefined,
        isCredit: o.data.isCredit,
        noCommission: o.data.noCommission,
        sortOrder,
      },
    });
    productIdByCode.set(created.code, created.id);
  }

  // (b) options
  for (const o of byOp("option.update")) {
    const c = o.changes;
    await tx.option.update({
      where: { id: o.id },
      data: {
        code: c.code?.to,
        legacyCodes: c.legacyCodes?.to,
        name: c.name?.to,
        shortDescription: c.shortDescription?.to,
        role: c.role?.to,
        parentProductId: c.parentProductCode
          ? c.parentProductCode.to
            ? need(productIdByCode, c.parentProductCode.to, "parent product")
            : null
          : undefined,
        unitLengthM: c.unitLengthM?.to,
        noCommission: c.noCommission?.to,
      },
    });
    if (c.code) {
      optionIdByCode.delete(c.code.from ?? "");
      optionIdByCode.set(c.code.to, o.id);
    }
  }
  for (const o of byOp("option.create")) {
    maxOptionSort += 1;
    const created = await tx.option.create({
      data: {
        code: o.data.code,
        legacyCodes: o.data.legacyCodes,
        name: o.data.name,
        shortDescription: o.data.shortDescription,
        role: o.data.role,
        parentProductId: o.data.parentProductCode ? need(productIdByCode, o.data.parentProductCode, "parent product") : null,
        unitLengthM: o.data.unitLengthM,
        noCommission: o.data.noCommission,
        sortOrder: maxOptionSort,
      },
    });
    optionIdByCode.set(created.code, created.id);
  }
  for (const o of byOp("compat.replace")) {
    const optionId = need(optionIdByCode, o.optionCode, "option");
    await tx.optionCompatibility.deleteMany({ where: { optionId } });
    await tx.optionCompatibility.createMany({
      data: [
        ...o.series.map((s) => ({ optionId, seriesId: need(seriesId, s, "series"), productId: null })),
        ...o.products.map((p) => ({ optionId, seriesId: null, productId: need(productIdByCode, p, "product") })),
      ],
    });
  }
  for (const o of byOp("price.set")) {
    const rid = need(regionId, o.price.regionCode, "region");
    const data = { amount: o.price.amount, needsReview: o.price.needsReview };
    if (o.target === "product") {
      const productId = need(productIdByCode, o.code, "product");
      await tx.price.upsert({
        where: { productId_regionId: { productId, regionId: rid } },
        update: data,
        create: { productId, regionId: rid, ...data },
      });
    } else {
      const optionId = need(optionIdByCode, o.code, "option");
      await tx.price.upsert({
        where: { optionId_regionId: { optionId, regionId: rid } },
        update: data,
        create: { optionId, regionId: rid, ...data },
      });
    }
  }

  // (c) deletes -- options first, then products
  for (const o of byOp("option.delete")) {
    await tx.option.delete({ where: { id: o.id } });
  }
  for (const o of byOp("product.delete")) {
    // Compatibility rows pointing at the product would otherwise be left
    // with both seriesId and productId null (the relation is SetNull).
    await tx.optionCompatibility.deleteMany({ where: { productId: o.id } });
    await tx.product.delete({ where: { id: o.id } });
  }
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  const targetPath = path.resolve(__dirname, "..", "docs", "reference", "catalog-v2-target.json");
  const target = JSON.parse(readFileSync(targetPath, "utf8")) as CatalogTarget;

  const { db } = await import("../src/lib/db");
  const snapshot = await readSnapshot(db);
  console.log(`snapshot: ${snapshot.products.length} products, ${snapshot.options.length} options`);

  let plan;
  try {
    plan = planCatalogV2(target, snapshot);
  } catch (e) {
    if (e instanceof PlanError) {
      console.error(e.message);
      process.exitCode = 1;
      return;
    }
    throw e;
  }

  for (const op of plan.operations) console.log(renderOperation(op));
  console.log("");
  console.log(renderSummary(plan.summary));

  if (plan.operations.length === 0) {
    console.log("nothing to do -- the database already reflects the target");
    return;
  }
  if (dryRun) {
    console.log(`dry run -- ${plan.operations.length} operation(s) not applied`);
    return;
  }

  await db.$transaction((tx) => apply(tx, plan.operations), { maxWait: 30_000, timeout: 300_000 });
  console.log(`applied ${plan.operations.length} operation(s)`);

  // Prove idempotence right away: a second plan over the migrated rows
  // must be empty.
  const after = planCatalogV2(target, await readSnapshot(db));
  if (after.operations.length) {
    console.warn(`warning: ${after.operations.length} operation(s) still planned after applying -- re-run --dry-run`);
    process.exitCode = 1;
  } else {
    console.log("verified: a second plan is empty");
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    const { db } = await import("../src/lib/db");
    await db.$disconnect();
  });
