/**
 * Idempotent DB seed: loads prisma/seed-data/catalog.json and upserts
 * Regions, Series, Products, Options, AU Prices and Option<->Series
 * compatibility. Safe to run repeatedly — every write is an upsert (or an
 * existence check before create, where Prisma's composite-key upsert can't
 * express a partial-unique-with-NULL constraint).
 *
 * Run:  npm run db:seed
 *
 * All mapping logic (catalog -> flat payloads) lives in prisma/seed-lib.ts
 * as pure functions so it can be unit tested without a database; this file
 * is the IO shell that turns those payloads into Prisma calls.
 */
import "dotenv/config";
import { Prisma } from "@prisma/client";
import catalogData from "./seed-data/catalog.json";
import contentBlocksData from "./seed-data/content-blocks.json";
import usPricesData from "./seed-data/prices-us.json";
import catalogV2Target from "../docs/reference/catalog-v2-target.json";
import type { CatalogTarget } from "../scripts/lib/catalog-v2-plan";
import { whereAnyCode } from "../src/lib/catalog-identity";
import {
  type Catalog,
  type ContentBlocksJson,
  type UsPricesJson,
  REGIONS,
  mapSeries,
  mapProducts,
  mapOptions,
  mapPrices,
  mapCompatibility,
  mapContentBlocks,
  mapUsPrices,
  missingUsPriceCodes,
  BLOCK_BODY_MIGRATIONS,
  shouldMigrateBlock,
} from "./seed-lib";

const catalog = catalogData as Catalog;
const contentBlocksJson = contentBlocksData as ContentBlocksJson;
const usPricesJson = usPricesData as UsPricesJson;
const v2Target = catalogV2Target as CatalogTarget;

/**
 * Rows catalogue v2 deletes (docs/reference/catalog-v2-target.json, action
 * "delete"): AU-only options, software sold as options, duplicates, the
 * X-Calibre widths not on the US list. scripts/migrate-catalog-v2.ts
 * removes them from a live database; the seed retires them too (delete, or
 * deactivate when a document still references the row) so a database seeded
 * from the pre-v2 catalog.json and never migrated still converges. Matched
 * by exact current code only -- a deleted row was never renamed, and a
 * legacy-code match could hit a surviving row.
 */
const V2_DELETED_OPTION_CODES = v2Target.options.filter((o) => o.action === "delete").map((o) => o.code);
const V2_DELETED_PRODUCT_CODES = v2Target.products.filter((p) => p.action === "delete").map((p) => p.code);

/** `where` matching a row by its current code or any code it used to have,
 *  including every legacy code the seed entry itself lists. */
function whereAnyOfCodes(codes: string[]) {
  return { OR: codes.flatMap((c) => whereAnyCode(c).OR) };
}

async function main() {
  // Import db module only after dotenv has loaded DATABASE_URL.
  const { db } = await import("../src/lib/db");

  // 1. Regions
  const regionIdByCode = new Map<string, string>();
  for (const r of REGIONS) {
    const region = await db.region.upsert({
      where: { code: r.code },
      update: {
        name: r.name,
        currency: r.currency,
        taxName: r.taxName,
        taxRate: r.taxRate,
        entityName: r.entityName,
        entityLegalId: r.entityLegalId ?? null,
        entityAddress: r.entityAddress ?? null,
        bankDetails: r.bankDetails ?? undefined,
        maxDiscountPct: r.maxDiscountPct,
      },
      create: {
        code: r.code,
        name: r.name,
        currency: r.currency,
        taxName: r.taxName,
        taxRate: r.taxRate,
        entityName: r.entityName,
        entityLegalId: r.entityLegalId,
        entityAddress: r.entityAddress,
        bankDetails: r.bankDetails,
        maxDiscountPct: r.maxDiscountPct,
      },
    });
    regionIdByCode.set(r.code, region.id);
  }

  // 2. Series
  const seriesIdByCode = new Map<string, string>();
  for (const s of mapSeries(catalog)) {
    const series = await db.series.upsert({
      where: { code: s.code },
      update: { name: s.name, maxDiscountPct: s.maxDiscountPct, sortOrder: s.sortOrder },
      create: { code: s.code, name: s.name, maxDiscountPct: s.maxDiscountPct, sortOrder: s.sortOrder },
    });
    seriesIdByCode.set(s.code, series.id);
  }

  // 3. Retire the options catalogue v2 deletes -- see V2_DELETED_OPTION_CODES
  // above. Delete an option outright when no DocumentLine snapshot
  // references it; when one does (a document that already used the option),
  // deleting would break that document's history, so instead the option is
  // deactivated (active: false) -- it's hidden from every catalog picker
  // (queries/catalog.ts already filters pickers to active: true) but the
  // existing document keeps rendering its frozen snapshot exactly as before.
  // Price and OptionCompatibility rows cascade on Option delete; a
  // deactivated option keeps both (it's not gone, just hidden).
  let retiredCount = 0;
  let deactivatedCount = 0;
  const survivingOptionCodes = new Set(catalog.options.flatMap((o) => [o.code, ...(o.legacyCodes ?? [])]));
  for (const code of V2_DELETED_OPTION_CODES) {
    if (survivingOptionCodes.has(code)) continue; // the file still carries it (as a code or legacy code) -- not retired
    const existing = await db.option.findUnique({ where: { code } });
    if (!existing) continue; // never seeded under this code (e.g. fresh DB) -- nothing to retire
    const refCount = await db.documentLine.count({ where: { refId: existing.id, kind: "OPTION" } });
    if (refCount > 0) {
      if (existing.active) {
        await db.option.update({ where: { id: existing.id }, data: { active: false } });
      }
      console.warn(
        `seed: retired option "${code}" is still referenced by ${refCount} document line(s) -- deactivated, not deleted`
      );
      deactivatedCount++;
      continue;
    }
    await db.option.delete({ where: { id: existing.id } });
    retiredCount++;
  }

  // 3b. Retire the products catalogue v2 deletes, by the same rule: delete
  // when nothing references the row, deactivate when a document does
  // (DocumentItem.productId is an optional relation -- deleting would null
  // it and orphan the item's product snapshot; deactivating hides the
  // product from every picker and leaves the document whole).
  let retiredProductCount = 0;
  let deactivatedProductCount = 0;
  const survivingProductCodes = new Set(
    catalog.series.flatMap((s) => s.products.flatMap((p) => [p.code, ...(p.legacyCodes ?? [])]))
  );
  for (const code of V2_DELETED_PRODUCT_CODES) {
    if (survivingProductCodes.has(code)) continue;
    const existing = await db.product.findUnique({ where: { code } });
    if (!existing) continue;
    const [itemCount, lineCount] = await Promise.all([
      db.documentItem.count({ where: { productId: existing.id } }),
      db.documentLine.count({ where: { refId: existing.id, kind: "PRODUCT" } }),
    ]);
    if (itemCount + lineCount > 0) {
      if (existing.active) {
        await db.product.update({ where: { id: existing.id }, data: { active: false } });
      }
      console.warn(
        `seed: retired product "${code}" is still referenced by ${itemCount + lineCount} document row(s) -- deactivated, not deleted`
      );
      deactivatedProductCount++;
      continue;
    }
    await db.optionCompatibility.deleteMany({ where: { productId: existing.id } });
    await db.product.delete({ where: { id: existing.id } });
    retiredProductCount++;
  }

  // 4. Products. Not an upsert by code: catalogue v2 renamed codes, so a
  // database that was migrated (or seeded before the rename) holds the row
  // under a code the file now lists in `legacyCodes`. Find by any code --
  // current or legacy, on either side -- and update in place (setting the
  // file's code and merging legacyCodes), create only when nothing matches.
  // Identity columns (kind/form/specs/contentBlockKey) come from the file
  // and nowhere else (see resolveProductIdentity). The content block is
  // linked by key; the row is created in step 8, so the key is a plain
  // string here and a missing block simply renders no section.
  const productIdByCode = new Map<string, string>();
  let productRenamed = 0;
  for (const p of mapProducts(catalog)) {
    const seriesId = seriesIdByCode.get(p.seriesCode);
    if (!seriesId) throw new Error(`seed: product ${p.code} references unknown series ${p.seriesCode}`);
    const existing = await db.product.findFirst({ where: whereAnyOfCodes([p.code, ...p.legacyCodes]) });
    const identity = {
      name: p.name,
      description: p.description,
      seriesId,
      sortOrder: p.sortOrder,
      isCredit: p.isCredit,
      noCommission: p.noCommission,
      kind: p.kind,
      form: p.form,
      specs: p.specs ?? Prisma.DbNull,
      contentBlockKey: p.contentBlockKey,
    };
    let productId: string;
    if (existing) {
      const legacyCodes = Array.from(
        new Set([...existing.legacyCodes, ...p.legacyCodes, ...(existing.code !== p.code ? [existing.code] : [])])
      ).filter((c) => c !== p.code);
      if (existing.code !== p.code) productRenamed++;
      await db.product.update({ where: { id: existing.id }, data: { code: p.code, legacyCodes, ...identity } });
      productId = existing.id;
    } else {
      const created = await db.product.create({ data: { code: p.code, legacyCodes: p.legacyCodes, ...identity } });
      productId = created.id;
    }
    productIdByCode.set(p.code, productId);
  }

  // 5. Options -- same any-code matching as products. parentProductId is
  // resolved from the file's parentProductCode through the map built above.
  const optionIdByCode = new Map<string, string>();
  let optionRenamed = 0;
  for (const o of mapOptions(catalog)) {
    const parentProductId = o.parentProductCode ? (productIdByCode.get(o.parentProductCode) ?? null) : null;
    if (o.parentProductCode && !parentProductId) {
      throw new Error(`seed: option ${o.code} references unknown parent product ${o.parentProductCode}`);
    }
    const existing = await db.option.findFirst({ where: whereAnyOfCodes([o.code, ...o.legacyCodes]) });
    const identity = {
      name: o.name,
      shortDescription: o.shortDescription,
      sortOrder: o.sortOrder,
      noCommission: o.noCommission,
      role: o.role,
      parentProductId,
      unitLengthM: o.unitLengthM,
      contentBlockKey: o.contentBlockKey,
    };
    let optionId: string;
    if (existing) {
      const legacyCodes = Array.from(
        new Set([...existing.legacyCodes, ...o.legacyCodes, ...(existing.code !== o.code ? [existing.code] : [])])
      ).filter((c) => c !== o.code);
      if (existing.code !== o.code) optionRenamed++;
      await db.option.update({ where: { id: existing.id }, data: { code: o.code, legacyCodes, ...identity } });
      optionId = existing.id;
    } else {
      const created = await db.option.create({ data: { code: o.code, legacyCodes: o.legacyCodes, ...identity } });
      optionId = created.id;
    }
    optionIdByCode.set(o.code, optionId);
  }

  // 6. Prices (AU only — the other regions have no pricing data yet)
  let priceCount = 0;
  for (const price of mapPrices(catalog, "AU")) {
    const regionId = regionIdByCode.get(price.regionCode);
    if (!regionId) throw new Error(`seed: price references unknown region ${price.regionCode}`);

    if (price.kind === "product") {
      const productId = productIdByCode.get(price.code);
      if (!productId) throw new Error(`seed: price references unknown product ${price.code}`);
      await db.price.upsert({
        where: { productId_regionId: { productId, regionId } },
        update: { amount: price.amount, needsReview: price.needsReview },
        create: { productId, regionId, amount: price.amount, needsReview: price.needsReview },
      });
    } else {
      const optionId = optionIdByCode.get(price.code);
      if (!optionId) throw new Error(`seed: price references unknown option ${price.code}`);
      await db.price.upsert({
        where: { optionId_regionId: { optionId, regionId } },
        update: { amount: price.amount, needsReview: price.needsReview },
        create: { optionId, regionId, amount: price.amount, needsReview: price.needsReview },
      });
    }
    priceCount++;
  }

  // 6b. Prices (US region) -- from prisma/seed-data/prices-us.json, written
  // by `npm run catalog:build-seed-data` from the US figures in
  // docs/reference/catalog-v2-target.json. Unlike step 6's AU prices, these are always
  // upserted regardless of whether a row already exists: the US price list
  // is the authoritative source for every code it covers, never a
  // provisional/needsReview placeholder, so a re-run always brings the DB
  // back in line with the file rather than leaving a stale value in place.
  const usMapping = mapUsPrices(catalog, usPricesJson);
  if (usMapping.unknownCodes.length) {
    console.warn(
      `seed: prices-us.json has ${usMapping.unknownCodes.length} code(s) not found in catalog.json (skipped): ` +
        usMapping.unknownCodes.join(", ")
    );
  }
  let usPriceCount = 0;
  const usRegionId = regionIdByCode.get("US");
  if (!usRegionId) throw new Error(`seed: US price references unknown region US`);
  for (const price of usMapping.payloads) {
    if (price.kind === "product") {
      const productId = productIdByCode.get(price.code);
      if (!productId) throw new Error(`seed: US price references unknown product ${price.code}`);
      await db.price.upsert({
        where: { productId_regionId: { productId, regionId: usRegionId } },
        update: { amount: price.amount, needsReview: price.needsReview },
        create: { productId, regionId: usRegionId, amount: price.amount, needsReview: price.needsReview },
      });
    } else {
      const optionId = optionIdByCode.get(price.code);
      if (!optionId) throw new Error(`seed: US price references unknown option ${price.code}`);
      await db.price.upsert({
        where: { optionId_regionId: { optionId, regionId: usRegionId } },
        update: { amount: price.amount, needsReview: price.needsReview },
        create: { optionId, regionId: usRegionId, amount: price.amount, needsReview: price.needsReview },
      });
    }
    usPriceCount++;
  }
  // Purely informational: catalog codes that simply have no US price yet
  // (the target file has no US figure for them, so prices-us.json omits
  // them).
  const missingUs = missingUsPriceCodes(catalog, usPricesJson);
  if (missingUs.length) {
    console.warn(`seed: ${missingUs.length} catalog code(s) have no US price yet: ${missingUs.join(", ")}`);
  }

  // 7. Option <-> Series/Product compatibility. Each row is series-level
  // (seriesId set, productId null) or product-level (productId set, seriesId
  // null) — never both, mirroring the two partial unique indexes in
  // schema.prisma. Both are partial ("WHERE the other column IS NULL"), so
  // Prisma's composite-key `upsert` (which can't target a NULL member)
  // doesn't apply either way — check for an existing row first, then create
  // if absent, same pattern for both branches.
  //
  // This used to be add-only, which meant a compatibility row removed from
  // catalog.json (e.g. an option's compatibleSeries/compatibleProducts
  // shrinking) never got cleaned up on an existing DB -- the stale row just
  // sat there forever, making e.g. an EL-2020-only accessory keep showing up
  // for EL-2420 too. It's now a full sync per option: after every desired
  // row from catalog.json is ensured to exist (the create-if-absent loop
  // below, unchanged), any *existing* OptionCompatibility row for an option
  // catalog.json still knows about, but whose (seriesId, productId) pair
  // catalog.json no longer lists, is deleted. Only options present in
  // catalog.json (i.e. in optionIdByCode) are touched this way -- a
  // hand-created/manual option outside the catalog JSON entirely keeps
  // whatever compatibility rows an admin gave it via the catalog UI.
  const desiredCompatByOption = new Map<string, Set<string>>();
  let compatCount = 0;
  for (const c of mapCompatibility(catalog)) {
    const optionId = optionIdByCode.get(c.optionCode);
    if (!optionId) {
      throw new Error(`seed: compatibility references unknown option ${c.optionCode}`);
    }

    const where =
      c.seriesCode !== undefined
        ? (() => {
            const seriesId = seriesIdByCode.get(c.seriesCode);
            if (!seriesId) {
              throw new Error(`seed: compatibility references unknown series ${c.seriesCode} (option ${c.optionCode})`);
            }
            return { optionId, seriesId, productId: null as string | null };
          })()
        : (() => {
            const productId = productIdByCode.get(c.productCode);
            if (!productId) {
              throw new Error(`seed: compatibility references unknown product ${c.productCode} (option ${c.optionCode})`);
            }
            return { optionId, seriesId: null as string | null, productId };
          })();

    // Track this pair as "desired" for the sync pass below, keyed the same
    // way regardless of which branch (series/product) produced it.
    const desiredKey = `${where.seriesId ?? ""}:${where.productId ?? ""}`;
    const desired = desiredCompatByOption.get(optionId) ?? new Set<string>();
    desired.add(desiredKey);
    desiredCompatByOption.set(optionId, desired);

    const existing = await db.optionCompatibility.findFirst({ where });
    if (!existing) {
      try {
        await db.optionCompatibility.create({ data: where });
      } catch (e) {
        // Two concurrent/duplicate seed runs can both pass the findFirst
        // check above and then race on the create -- the loser hits the
        // relevant partial unique index (optionId, seriesId) WHERE productId
        // IS NULL, or (optionId, productId) WHERE seriesId IS NULL, as a
        // P2002 unique-constraint violation. That's the same "already
        // compatible" outcome the findFirst branch above no-ops on, so treat
        // it the same way instead of failing the whole seed run. Any other
        // error is a genuine problem and must still propagate.
        const isDuplicate = e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
        if (!isDuplicate) throw e;
      }
    }
    compatCount++;
  }

  // 7b. Compatibility sync: delete every existing OptionCompatibility row,
  // for an option catalog.json still knows about, whose pair isn't in that
  // option's desired set built above. Deliberately scoped to
  // `optionIdByCode` (options seeded from catalog.json) rather than every
  // Option row in the DB -- a manual/hand-created option's compatibility is
  // never touched by this sync.
  let compatDeletedCount = 0;
  for (const optionId of optionIdByCode.values()) {
    const desired = desiredCompatByOption.get(optionId) ?? new Set<string>();
    const existingRows = await db.optionCompatibility.findMany({ where: { optionId } });
    for (const row of existingRows) {
      const key = `${row.seriesId ?? ""}:${row.productId ?? ""}`;
      if (!desired.has(key)) {
        await db.optionCompatibility.delete({ where: { id: row.id } });
        compatDeletedCount++;
      }
    }
  }
  if (compatDeletedCount) {
    console.log(`seed: compatibility sync removed ${compatDeletedCount} stale OptionCompatibility row(s)`);
  }

  // 8. Content blocks -- one regionId:null "default" row per key from
  // prisma/seed-data/content-blocks.json. Create if the key has never been
  // seeded before; if a default row already exists, leave it entirely alone
  // (never overwrite title/body/sortOrder) so an admin's edits made via
  // /settings/content always win over re-running the seed. Like
  // OptionCompatibility above, ContentBlock's @@unique([key, regionId]) can't
  // stop two regionId:null rows for the same key at the Postgres level
  // (NULL is never equal to NULL for uniqueness purposes), so this checks
  // first via findFirst rather than a composite-key upsert, and tolerates a
  // P2002 from a concurrent/duplicate seed run the same way compatibility
  // rows do.
  let contentBlockCreated = 0;
  let contentBlockSkipped = 0;
  for (const block of mapContentBlocks(contentBlocksJson)) {
    const existing = await db.contentBlock.findFirst({
      where: { key: block.key, regionId: null },
    });
    if (existing) {
      contentBlockSkipped++;
      continue;
    }
    try {
      await db.contentBlock.create({
        data: {
          key: block.key,
          regionId: null,
          title: block.title,
          body: block.body,
          sortOrder: block.sortOrder,
        },
      });
      contentBlockCreated++;
    } catch (e) {
      const isDuplicate = e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
      if (!isDuplicate) throw e;
      contentBlockSkipped++;
    }
  }

  // 8b. Targeted content-block body migrations -- see `BLOCK_BODY_MIGRATIONS`
  // (prisma/seed-lib.ts) for why this is separate from step 8's "never
  // overwrite an existing row" rule. Handles the "machine.m-series" case
  // today: commit 315e089 removed a duplicate inline heading from its body
  // (the quotation renderer already prints its own heading from the block's
  // title), so any DB seeded before that commit still has the old,
  // duplicate-heading body. Force-updates title+body to the new seed-data
  // value, but only when the existing row's body is byte-for-byte the known
  // old value (`shouldMigrateBlock`) -- an admin edit (body differs from
  // both the old *and* new seeded value) is left untouched and warned about.
  let blockMigratedCount = 0;
  let blockMigrationSkipped = 0;
  for (const [key, migration] of Object.entries(BLOCK_BODY_MIGRATIONS)) {
    const newBlock = contentBlocksJson.blocks.find((b) => b.key === key);
    if (!newBlock) continue; // shouldn't happen -- defensive, content-blocks.json always has every migrated key
    const existing = await db.contentBlock.findFirst({ where: { key, regionId: null } });
    if (!existing) continue; // never seeded on this DB, or just created fresh (with the new body) by step 8 above
    if (!shouldMigrateBlock(existing.body, migration.oldBody)) {
      if (existing.body !== newBlock.body) {
        console.warn(`seed: content block "${key}" was admin-edited -- skipped body migration`);
        blockMigrationSkipped++;
      }
      continue;
    }
    await db.contentBlock.update({
      where: { id: existing.id },
      data: { title: newBlock.title, body: newBlock.body },
    });
    blockMigratedCount++;
  }

  // A seeded row's content block is a key set in step 4/5 from the file;
  // warn when the file names a block content-blocks.json does not seed, so
  // a typo in the target file shows up here rather than as a silently
  // missing quotation section.
  const blockKeys = new Set((await db.contentBlock.findMany({ select: { key: true } })).map((b) => b.key));
  const danglingBlockKeys = [...mapProducts(catalog), ...mapOptions(catalog)]
    .filter((row) => row.contentBlockKey !== null && !blockKeys.has(row.contentBlockKey))
    .map((row) => `${row.code} -> ${row.contentBlockKey}`);
  if (danglingBlockKeys.length) {
    console.warn(`seed: ${danglingBlockKeys.length} row(s) name a content block that does not exist: ${danglingBlockKeys.join(", ")}`);
  }

  console.log("seed: done");
  console.log(`  regions:        ${regionIdByCode.size}`);
  console.log(`  series:         ${seriesIdByCode.size}`);
  console.log(`  retired options: ${retiredCount} deleted, ${deactivatedCount} deactivated`);
  console.log(`  retired products: ${retiredProductCount} deleted, ${deactivatedProductCount} deactivated`);
  console.log(`  renamed to v2 codes: ${productRenamed} products, ${optionRenamed} options`);
  console.log(`  products:       ${productIdByCode.size}`);
  console.log(`  options:        ${optionIdByCode.size}`);
  console.log(`  prices (AU):    ${priceCount}`);
  console.log(`  prices (US):    ${usPriceCount}`);
  console.log(`  compatibility:  ${compatCount} ensured, ${compatDeletedCount} stale removed`);
  console.log(`  content blocks: ${contentBlockCreated} created, ${contentBlockSkipped} skipped (already seeded)`);
  console.log(
    `  content block migrations: ${blockMigratedCount} migrated, ${blockMigrationSkipped} skipped (admin-edited)`
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => process.exit(0));
