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
import { backfillCatalogIdentity } from "../scripts/lib/catalog-identity-backfill";
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

/**
 * Option codes retired from the catalog -- either reclassified as products
 * (the EasyLoader/EasyFeeder/Software fix below) or genuinely discontinued
 * (FM180). A retired code's Option row is never left seeded alongside its
 * replacement/discontinuation: see the retirement loop in main() for how
 * each one is actually removed (delete, or deactivate if still referenced).
 *
 * EasyLoader/EasyFeeder/Software reclassification: these sheets' rows were
 * originally (incorrectly) extracted entirely as options, leaving their
 * series with 0 products. They're now products (see
 * scripts/extract-catalog.ts), so any pre-existing Option row seeded under
 * the old code must be removed -- otherwise it lingers alongside its new
 * product-equivalent, duplicating the item in the catalog UI.
 *
 * Exact old codes, as they existed in prisma/seed-data/catalog.json before
 * this fix (captured from the pre-change catalog, not regenerated):
 *  - the 2 EasyLoader drive-module options -> now products EL-2020 / EL-2420
 *  - the 3 EasyFeeder options -> now products EF-2020 / EF-2420 / EF-4030
 *  - the 10 Software options (incl. PRA-SW) -> now SW-series products of the
 *    same codes (PRA-SW's SW-sheet counterpart is now product code "PRA";
 *    L-Series' differently-priced "PRA-L" option is unaffected and stays).
 *
 * FM180 ("Fabric Master"): not sold anymore (owner decision) -- dropped from
 * extraction entirely (scripts/extract-catalog.ts skips its M-series sheet
 * row), so it needs the same existing-DB cleanup as the reclassified codes
 * above, just for "discontinued" rather than "renamed into a product".
 */
const RETIRED_OPTION_CODES: string[] = [
  // The EasyLoader drive modules used to be listed here ("-> products
  // EL-2020 / EL-2420"), but catalog.json still carries them as options and
  // the EasyLoader builder writes them as option lines (table-sections.ts),
  // so every seed run deleted them in this step and recreated them with a
  // new id in step 6 -- orphaning any document line that referenced the old
  // row. Owner (2026-09-05): the EasyLoader is a product assembled from its
  // options; the drive module stays an option.
  // EasyFeeder -> products EF-2020 / EF-2420 / EF-4030.
  "EasyFeeder- 2020",
  "EasyFeeder- 2420",
  "EasyFeeder- 4030",
  // Software -> products of the same codes.
  "ANT-V5",
  "ANT-V6",
  "EDG",
  "LS Convert",
  "PDG",
  "PRA-SW",
  "PTN",
  "PTW(S)",
  "WPL",
  "WPN",
  // Discontinued -- not a reclassification, just retired outright.
  "FM180",
];

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

  // 1b. Rename legacy Series.code "XC" -> "X" -- X-Calibre's *series code*
  // changed from "XC" to "X" (owner: the catalog UI showed "XC" but should
  // read "X"; see scripts/extract-catalog.ts's compatibleSeriesFor). Product
  // codes were already "X-####" before this rename and are unaffected --
  // that's the separate "legacy XC-####" product-code migration further
  // down (step 4). Renaming in place (not delete+recreate) preserves the
  // series' id and every relation to it (Products, OptionCompatibility rows,
  // etc). Must run before the series upsert loop below, which upserts by
  // code and would otherwise create a brand new "X" series row alongside an
  // untouched legacy "XC" one on every existing DB. P2002-tolerant: if a "X"
  // series row already exists (shouldn't happen -- this migration only ever
  // needs to run once per DB), log a warning and skip rather than crashing
  // the whole seed run.
  let renamedSeriesCount = 0;
  try {
    const result = await db.series.updateMany({ where: { code: "XC" }, data: { code: "X" } });
    renamedSeriesCount = result.count;
  } catch (e) {
    const isDuplicate = e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
    if (!isDuplicate) throw e;
    console.warn(`seed: cannot rename series "XC" -> "X" -- a series with code "X" already exists; skipped`);
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

  // 3. Retire options reclassified as products, or otherwise removed
  // (discontinued), by this catalog revision -- see RETIRED_OPTION_CODES
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
  for (const code of RETIRED_OPTION_CODES) {
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

  // 4. Rename legacy "XC-####" product codes to "X-####" (the X-Calibre
  // product-code prefix changed from "XC-" to "X-" -- see
  // scripts/extract-catalog.ts; this is unrelated to step 1b's *series*
  // code rename above, which is a separate field on a separate row).
  // Existing DBs (local and the future VPS) may already contain products
  // seeded under the old "XC-####" codes, and some may already be referenced by
  // DocumentItems (e.g. a finalized quote) -- those rows can never be
  // deleted, and duplicating them under the new code is unacceptable, so
  // this renames the code string in place instead. Renaming (rather than
  // delete+recreate) preserves the product's id and every relation to it
  // (DocumentItems, Prices, OptionCompatibility, etc). If a product already
  // exists under the target "X-####" code (shouldn't happen — codes are
  // unique and this migration only ever needs to run once per row), the
  // update hits the unique-code constraint (P2002); log a warning and skip
  // rather than crashing the whole seed run.
  let renamedXCount = 0;
  const legacyXCProducts = await db.product.findMany({
    where: { code: { startsWith: "XC-" } },
  });
  for (const product of legacyXCProducts) {
    const match = /^XC-(\d+)$/.exec(product.code);
    if (!match) continue; // not a plain "XC-####" code -- leave untouched
    const newCode = `X-${match[1]}`;
    try {
      await db.product.update({
        where: { id: product.id },
        data: { code: newCode },
      });
      renamedXCount++;
    } catch (e) {
      const isDuplicate = e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
      if (!isDuplicate) throw e;
      console.warn(
        `seed: cannot rename product "${product.code}" -> "${newCode}" -- a product with code "${newCode}" already exists; skipped`
      );
    }
  }

  // 4b. Rename legacy "HDRF" product code to "HDRF-180" -- the single
  // width-less "HDRF" product was split into three real width variants,
  // HDRF-180/220/320 (owner decision, model like EasyLoader's own per-width
  // products -- see MANUAL_PRODUCTS.EF in scripts/extract-catalog.ts).
  // Existing DBs may already have a product seeded under the old "HDRF"
  // code, possibly with an image and/or a Price row already attached (and
  // possibly referenced by a DocumentItem) -- renaming in place (rather than
  // delete+recreate) preserves all of that instead of orphaning it. HDRF-180
  // is the target (not HDRF-220/320) because it's the width the retired
  // "HDRF" product's own description matched (up to 1800mm) and the one the
  // old AU price, if any, was seeded against. The step 5 upsert loop below
  // then creates HDRF-220/HDRF-320 as brand new products, same as any other
  // catalog addition. P2002-tolerant, same convention as every other rename
  // step in this file.
  let renamedHdrfCount = 0;
  const legacyHdrf = await db.product.findUnique({ where: { code: "HDRF" } });
  if (legacyHdrf) {
    try {
      await db.product.update({ where: { id: legacyHdrf.id }, data: { code: "HDRF-180" } });
      renamedHdrfCount = 1;
    } catch (e) {
      const isDuplicate = e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002";
      if (!isDuplicate) throw e;
      console.warn(`seed: cannot rename product "HDRF" -> "HDRF-180" -- a product with code "HDRF-180" already exists; skipped`);
    }
  }

  // 5. Products
  const productIdByCode = new Map<string, string>();
  for (const p of mapProducts(catalog)) {
    const seriesId = seriesIdByCode.get(p.seriesCode);
    if (!seriesId) throw new Error(`seed: product ${p.code} references unknown series ${p.seriesCode}`);
    const product = await db.product.upsert({
      where: { code: p.code },
      update: { name: p.name, description: p.description, seriesId, sortOrder: p.sortOrder, isCredit: p.isCredit },
      create: {
        code: p.code,
        name: p.name,
        description: p.description,
        seriesId,
        sortOrder: p.sortOrder,
        isCredit: p.isCredit,
      },
    });
    productIdByCode.set(p.code, product.id);
  }

  // 6. Options
  const optionIdByCode = new Map<string, string>();
  for (const o of mapOptions(catalog)) {
    const option = await db.option.upsert({
      where: { code: o.code },
      update: { name: o.name, shortDescription: o.shortDescription, sortOrder: o.sortOrder },
      create: { code: o.code, name: o.name, shortDescription: o.shortDescription, sortOrder: o.sortOrder },
    });
    optionIdByCode.set(o.code, option.id);
  }

  // 7. Prices (AU only — the other regions have no pricing data yet)
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

  // 7b. Prices (US region) -- from prisma/seed-data/prices-us.json, written
  // by `npm run extract:us-prices` (RAW/Price List North America
  // (01-06-2026).xlsx). Unlike step 7's AU prices, these are always
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
  // (services/new-width variants etc. that scripts/extract-us-prices.ts
  // deliberately left out of prices-us.json's `prices` array are not
  // catalog codes at all, so they never appear here).
  const missingUs = missingUsPriceCodes(catalog, usPricesJson);
  if (missingUs.length) {
    console.warn(`seed: ${missingUs.length} catalog code(s) have no US price yet: ${missingUs.join(", ")}`);
  }

  // 8. Option <-> Series/Product compatibility. Each row is series-level
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

  // 8b. Compatibility sync: delete every existing OptionCompatibility row,
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

  // 9. Content blocks -- one regionId:null "default" row per key from
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

  // 9b. Targeted content-block body migrations -- see `BLOCK_BODY_MIGRATIONS`
  // (prisma/seed-lib.ts) for why this is separate from step 9's "never
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
    if (!existing) continue; // never seeded on this DB, or just created fresh (with the new body) by step 9 above
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

  console.log("seed: done");
  console.log(`  regions:        ${regionIdByCode.size}`);
  console.log(`  renamed XC->X series: ${renamedSeriesCount}`);
  console.log(`  series:         ${seriesIdByCode.size}`);
  console.log(`  retired options: ${retiredCount} deleted, ${deactivatedCount} deactivated`);
  console.log(`  renamed XC->X product codes: ${renamedXCount}`);
  console.log(`  renamed HDRF->HDRF-180: ${renamedHdrfCount}`);
  // 10. Identity columns (migration z31_catalog_identity): kind, form,
  // specs, role, parent, unit length, content block. catalog.json carries
  // only legacy codes, so these are derived from the codes by the rules in
  // src/lib/catalog-identity.ts -- for rows not classified yet. A row an
  // admin has already classified keeps what they set. Runs last because the
  // content-block keys it links to are created in step 9.
  const identity = await backfillCatalogIdentity(db, "missing");

  console.log(`  products:       ${productIdByCode.size}`);
  console.log(`  options:        ${optionIdByCode.size}`);
  console.log(`  identity:       ${identity.products.written} products, ${identity.options.written} options classified`);
  if (identity.options.unresolvedParents.length) {
    console.warn(`  identity: EasyLoader parent not found for ${identity.options.unresolvedParents.join(", ")}`);
  }
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
