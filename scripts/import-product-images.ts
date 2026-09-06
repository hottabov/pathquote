/**
 * Imports catalog images: product/series photos (PNG), option icons and the
 * region brand logo (both SVG). Every source file is copied into the
 * uploads directory (content-addressed by md5, matching src/lib/uploads.ts's
 * saveUpload naming convention, extension preserved) and the matching DB
 * rows' image/logo URL is pointed at the resulting `/api/files/<name>` URL.
 *
 * Mapping lives in scripts/import-images-lib.ts (pure, unit tested). Product
 * and option codes in the maps are matched against the database by their
 * current code (`findUnique({ where: { code } })`). A code is only a label
 * -- the row's identity is its id -- but from outside the app it is the one
 * handle there is, so the maps carry the catalogue's current codes and a
 * renamed row needs its map entry updated. The icon base codes
 * (ICON_OPTION_TARGETS keys) name files on disk (iconFilename).
 *  - SERIES_IMAGES: every product in a whole series gets that series'
 *    image (M, X, L, LNS, EF, FP -- one photo per product line), AND the
 *    Series row itself gets the same image as its own imageUrl (only-if-
 *    null, same as everything else here) -- see Series.imageUrl in
 *    schema.prisma and listSeriesWithCounts in src/lib/queries/catalog.ts,
 *    which resolves a series' /catalog card image from this field (falling
 *    back to a product's imageUrl, and finally to a placeholder, when it's
 *    still null -- e.g. for P/EL, which have no SERIES_IMAGES entry).
 *  - PRODUCT_IMAGES: individual SW-series software modules that share
 *    PathWorks' screenshot, plus Production Analyst's own image, plus the
 *    hand-authored manual products (FP-TROLLEY, HDRF-180/220/320) with their
 *    own standalone photos. Every code was verified against
 *    prisma/seed-data/catalog.json -- see that file's doc comment.
 *  - ICON_OPTION_TARGETS: per-option icons under
 *    prisma/seed-data/option-icons/ -> Option.imageUrl. Primary purpose of
 *    this whole icon set.
 *  - ICON_PRODUCT_TARGETS: the same icons, bonus-applied to a few
 *    Product.imageUrl too (only-if-null, so it mostly no-ops against
 *    products PRODUCT_IMAGES already covered -- see that map's comment).
 *  - The single region brand logo under prisma/seed-data/brand/pf-logo.png
 *    -> every Region's logoUrl (active or not), only-if-null.
 * Deliberately unmapped, by design (no catalog code / no useful
 * stand-alone image): EasyLoader (EL series) product photos; the JTP option
 * icon (see UNMAPPED_ICONS); punchline.png (Punchline/"P" was retired from
 * the catalog entirely -- see UNMAPPED_IMAGE_FILES).
 *
 * Idempotent:
 *  - Filenames are content-addressed, so re-running never duplicates a
 *    file under uploadsDir() (skipped once it exists).
 *  - A row's image/logo URL is only ever set once it's null, so a manually
 *    changed or cleared image is never clobbered by a re-run -- pass
 *    --force to overwrite regardless.
 *
 * Usage:
 *   npm run images:import [-- --dry] [-- --force] [-- --refresh-icons]
 *   tsx scripts/import-product-images.ts [--dry] [--force] [--refresh-icons]
 *
 * --dry            Print the plan (files that would be copied, rows that
 *                   would be updated) without writing anything to disk or
 *                   the database.
 * --force          Overwrite an image/logo URL even on a row that already
 *                   has one (product/series photos, option icons, and the
 *                   region logo -- everything this script touches).
 * --refresh-icons  Narrower than --force: overwrites Option.imageUrl for
 *                   every ICON_OPTION_TARGETS-mapped option, and every
 *                   Region.logoUrl, unconditionally -- without touching
 *                   product/series photos that already have one. Meant for
 *                   one-off use after the option icons or brand logo were
 *                   re-vendored (e.g. the PNG -> SVG migration) while a
 *                   database already has the old PNG uploads' URLs set --
 *                   the normal only-if-null rule would otherwise leave
 *                   those stale.
 */
import "dotenv/config";
import { existsSync } from "node:fs";
import { mkdir, copyFile, readFile } from "node:fs/promises";
import path from "node:path";
import {
  SERIES_IMAGES,
  PRODUCT_IMAGES,
  UNMAPPED_IMAGE_FILES,
  distinctImageFiles,
  md5UuidFilename,
  ICON_OPTION_TARGETS,
  ICON_PRODUCT_TARGETS,
  UNMAPPED_ICONS,
  distinctIconCodes,
  iconFilename,
  allIconOptionCodes,
} from "./import-images-lib";
import catalogData from "../prisma/seed-data/catalog.json";
import type { Catalog } from "../prisma/seed-lib";

const SOURCE_DIR = path.resolve(__dirname, "..", "prisma", "seed-data", "product-images");
const ICONS_SOURCE_DIR = path.resolve(__dirname, "..", "prisma", "seed-data", "option-icons");
const BRAND_SOURCE_DIR = path.resolve(__dirname, "..", "prisma", "seed-data", "brand");
const BRAND_LOGO_FILE = "pf-logo.svg";

const catalog = catalogData as Catalog;

type Target = { code: string; imageUrl: string; via: string };

async function main() {
  const args = process.argv.slice(2);
  const dry = args.includes("--dry");
  const force = args.includes("--force");
  const refreshIcons = args.includes("--refresh-icons");

  // Imported only now (not at module scope) so `--dry`/`--force` parsing
  // above can't accidentally be skipped by an early DB/env failure --
  // mirrors scripts/create-user.ts's "import db module only after
  // validation" convention.
  const { db } = await import("../src/lib/db");
  const { uploadsDir, IMAGE_URL_PATTERN } = await import("../src/lib/uploads");

  const destDir = uploadsDir();
  if (!dry) await mkdir(destDir, { recursive: true });

  // 0) Sanity check: every Option code targeted by ICON_OPTION_TARGETS
  // should exist in catalog.json. A mismatch here means the map (in
  // import-images-lib.ts) has drifted from the catalog -- warn loudly but
  // keep going, since the per-option lookup below already skips missing
  // codes safely.
  const catalogOptionCodes = new Set(catalog.options.map((o) => o.code));
  for (const optionCode of allIconOptionCodes()) {
    if (!catalogOptionCodes.has(optionCode)) {
      console.warn(
        `warning: option code "${optionCode}" (from ICON_OPTION_TARGETS) not found in prisma/seed-data/catalog.json -- mapping mismatch`
      );
    }
  }

  // 1) Hash + copy every distinct source image exactly once.
  const filenameBySource = new Map<string, string>();
  for (const sourceFile of distinctImageFiles()) {
    const sourcePath = path.join(SOURCE_DIR, sourceFile);
    if (!existsSync(sourcePath)) {
      // A mapped source file missing from the vendored product-images/
      // directory is an environment/setup problem, not a data mismatch --
      // fail loudly rather than silently skip every product that needed it.
      throw new Error(`mapped source image not found: ${sourcePath}`);
    }

    const buffer = await readFile(sourcePath);
    const filename = md5UuidFilename(buffer);
    filenameBySource.set(sourceFile, filename);

    const destPath = path.join(destDir, filename);
    const alreadyExists = existsSync(destPath);
    if (dry) {
      console.log(`[dry] ${sourceFile} -> ${filename}${alreadyExists ? " (already in uploads)" : ""}`);
      continue;
    }
    if (alreadyExists) continue;
    await copyFile(sourcePath, destPath);
    console.log(`copied ${sourceFile} -> ${filename}`);
  }

  // 1b) Also set Series.imageUrl directly from SERIES_IMAGES -- distinct
  // from step 3 below (which applies the same map to every *product* in the
  // series). This is what makes the /catalog series cards (see
  // listSeriesWithCounts in src/lib/queries/catalog.ts) show nice art on a
  // fresh install even before any admin sets a per-series override --
  // same only-if-null-unless---force convention as every other target here.
  let seriesImageUpdated = 0;
  let seriesImageSkippedHasImage = 0;
  let seriesImageSkippedMissing = 0;
  const seriesImageMismatches: string[] = [];

  for (const [seriesCode, sourceFile] of Object.entries(SERIES_IMAGES)) {
    const filename = filenameBySource.get(sourceFile);
    if (!filename) continue; // unreachable: distinctImageFiles() always covers every mapping value

    const imageUrl = `/api/files/${filename}`;
    if (!IMAGE_URL_PATTERN.test(imageUrl)) {
      // Defensive only -- md5UuidFilename always produces a matching shape.
      throw new Error(`internal error: built imageUrl "${imageUrl}" doesn't match IMAGE_URL_PATTERN`);
    }

    const series = await db.series.findUnique({ where: { code: seriesCode } });
    if (!series) {
      seriesImageSkippedMissing++;
      seriesImageMismatches.push(seriesCode);
      console.warn(`warning: series code "${seriesCode}" (from SERIES_IMAGES) not found in catalog -- skipped`);
      continue;
    }

    if (series.imageUrl !== null && !force) {
      seriesImageSkippedHasImage++;
      console.log(`skip (already has an image): series ${seriesCode}`);
      continue;
    }

    if (dry) {
      console.log(`[dry] would set series ${seriesCode}.imageUrl = ${imageUrl}`);
      seriesImageUpdated++;
      continue;
    }

    await db.series.update({ where: { id: series.id }, data: { imageUrl } });
    seriesImageUpdated++;
    console.log(`updated series ${seriesCode} -> ${imageUrl}`);
  }

  // 2) Resolve every mapped series/product code to its target imageUrl. A
  // Map (not a plain array) so a code reachable through two different
  // mappings with conflicting images is caught rather than silently
  // applying whichever happened to run last.
  const targetByCode = new Map<string, Target>();
  function addTarget(code: string, imageUrl: string, via: string) {
    const existing = targetByCode.get(code);
    if (existing && existing.imageUrl !== imageUrl) {
      console.warn(
        `warning: product "${code}" is reachable via both ${existing.via} and ${via} with different images -- keeping ${existing.via}`
      );
      return;
    }
    targetByCode.set(code, { code, imageUrl, via });
  }

  for (const [seriesCode, sourceFile] of Object.entries(SERIES_IMAGES)) {
    const filename = filenameBySource.get(sourceFile);
    if (!filename) continue; // unreachable: distinctImageFiles() always covers every mapping value

    const series = await db.series.findUnique({
      where: { code: seriesCode },
      include: { products: { select: { code: true } } },
    });
    if (!series) {
      console.warn(`warning: series code "${seriesCode}" (from SERIES_IMAGES) not found in catalog -- mapping mismatch, skipped`);
      continue;
    }
    if (series.products.length === 0) {
      console.warn(`warning: series "${seriesCode}" has no products -- nothing to update for it`);
    }
    for (const product of series.products) {
      addTarget(product.code, `/api/files/${filename}`, `series ${seriesCode}`);
    }
  }

  for (const [productCode, sourceFile] of Object.entries(PRODUCT_IMAGES)) {
    const filename = filenameBySource.get(sourceFile);
    if (!filename) continue; // unreachable, see above
    addTarget(productCode, `/api/files/${filename}`, "product code");
  }

  // 3) Apply -- one product at a time so "already has an image" is a
  // per-product skip, not all-or-nothing.
  let updated = 0;
  let skippedHasImage = 0;
  let skippedMissingProduct = 0;
  const mismatchedCodes: string[] = [];

  for (const target of Array.from(targetByCode.values()).sort((a, b) => a.code.localeCompare(b.code))) {
    if (!IMAGE_URL_PATTERN.test(target.imageUrl)) {
      // Defensive only -- md5UuidFilename always produces a matching shape.
      throw new Error(`internal error: built imageUrl "${target.imageUrl}" doesn't match IMAGE_URL_PATTERN`);
    }

    const product = await db.product.findUnique({ where: { code: target.code } });
    if (!product) {
      skippedMissingProduct++;
      mismatchedCodes.push(target.code);
      console.warn(`warning: product code "${target.code}" (${target.via}) not found in catalog -- skipped`);
      continue;
    }

    if (product.imageUrl !== null && !force) {
      skippedHasImage++;
      console.log(`skip (already has an image): ${target.code}`);
      continue;
    }

    if (dry) {
      console.log(`[dry] would set ${target.code}.imageUrl = ${target.imageUrl}`);
      updated++;
      continue;
    }

    await db.product.update({ where: { id: product.id }, data: { imageUrl: target.imageUrl } });
    updated++;
    console.log(`updated ${target.code} -> ${target.imageUrl}`);
  }

  // 4) Option icons: hash + copy every distinct icon PNG exactly once, same
  // content-addressed scheme as step 1.
  const iconFilenameByCode = new Map<string, string>();
  for (const iconCode of distinctIconCodes()) {
    const sourceFile = iconFilename(iconCode);
    const sourcePath = path.join(ICONS_SOURCE_DIR, sourceFile);
    if (!existsSync(sourcePath)) {
      throw new Error(`mapped icon source not found: ${sourcePath}`);
    }

    const buffer = await readFile(sourcePath);
    const filename = md5UuidFilename(buffer, "svg");
    iconFilenameByCode.set(iconCode, filename);

    const destPath = path.join(destDir, filename);
    const alreadyExists = existsSync(destPath);
    if (dry) {
      console.log(`[dry] ${sourceFile} -> ${filename}${alreadyExists ? " (already in uploads)" : ""}`);
      continue;
    }
    if (alreadyExists) continue;
    await copyFile(sourcePath, destPath);
    console.log(`copied ${sourceFile} -> ${filename}`);
  }

  // 5) Apply icon -> Option targets (the primary purpose of the icon set).
  let optionUpdated = 0;
  let optionSkippedHasImage = 0;
  let optionSkippedMissing = 0;
  const optionMismatches: string[] = [];

  for (const [iconCode, optionCodes] of Object.entries(ICON_OPTION_TARGETS)) {
    const filename = iconFilenameByCode.get(iconCode);
    if (!filename) continue; // unreachable: distinctIconCodes() always covers every mapping value
    const imageUrl = `/api/files/${filename}`;
    if (!IMAGE_URL_PATTERN.test(imageUrl)) {
      throw new Error(`internal error: built imageUrl "${imageUrl}" doesn't match IMAGE_URL_PATTERN`);
    }

    for (const optionCode of optionCodes) {
      const option = await db.option.findUnique({ where: { code: optionCode } });
      if (!option) {
        optionSkippedMissing++;
        optionMismatches.push(optionCode);
        console.warn(`warning: option code "${optionCode}" (icon ${iconCode}) not found in catalog -- skipped`);
        continue;
      }

      if (option.imageUrl !== null && !force && !refreshIcons) {
        optionSkippedHasImage++;
        console.log(`skip (already has an image): option ${optionCode}`);
        continue;
      }

      if (dry) {
        console.log(`[dry] would set option ${optionCode}.imageUrl = ${imageUrl}`);
        optionUpdated++;
        continue;
      }

      await db.option.update({ where: { id: option.id }, data: { imageUrl } });
      optionUpdated++;
      console.log(`updated option ${optionCode} -> ${imageUrl}`);
    }
  }

  // 6) Apply icon -> Product targets (bonus; only-if-null, so this mostly
  // no-ops against codes PRODUCT_IMAGES already filled in step 3 above --
  // see ICON_PRODUCT_TARGETS's doc comment).
  let iconProductUpdated = 0;
  let iconProductSkippedHasImage = 0;
  let iconProductSkippedMissing = 0;
  const iconProductMismatches: string[] = [];

  for (const [iconCode, productCodes] of Object.entries(ICON_PRODUCT_TARGETS)) {
    const filename = iconFilenameByCode.get(iconCode);
    if (!filename) continue; // unreachable, see above
    const imageUrl = `/api/files/${filename}`;

    for (const productCode of productCodes) {
      const product = await db.product.findUnique({ where: { code: productCode } });
      if (!product) {
        iconProductSkippedMissing++;
        iconProductMismatches.push(productCode);
        console.warn(`warning: product code "${productCode}" (icon ${iconCode}) not found in catalog -- skipped`);
        continue;
      }

      if (product.imageUrl !== null && !force) {
        iconProductSkippedHasImage++;
        console.log(`skip (already has an image): product ${productCode}`);
        continue;
      }

      if (dry) {
        console.log(`[dry] would set product ${productCode}.imageUrl = ${imageUrl}`);
        iconProductUpdated++;
        continue;
      }

      await db.product.update({ where: { id: product.id }, data: { imageUrl } });
      iconProductUpdated++;
      console.log(`updated product ${productCode} -> ${imageUrl}`);
    }
  }

  // 7) Region brand logo: one fixed source file, applied to EVERY region
  // (active or not), only-if-null unless --force.
  const brandLogoPath = path.join(BRAND_SOURCE_DIR, BRAND_LOGO_FILE);
  if (!existsSync(brandLogoPath)) {
    throw new Error(`brand logo not found: ${brandLogoPath}`);
  }
  const logoBuffer = await readFile(brandLogoPath);
  const logoFilename = md5UuidFilename(logoBuffer, "svg");
  const logoDestPath = path.join(destDir, logoFilename);
  const logoAlreadyExists = existsSync(logoDestPath);
  if (dry) {
    console.log(`[dry] ${BRAND_LOGO_FILE} -> ${logoFilename}${logoAlreadyExists ? " (already in uploads)" : ""}`);
  } else if (!logoAlreadyExists) {
    await copyFile(brandLogoPath, logoDestPath);
    console.log(`copied ${BRAND_LOGO_FILE} -> ${logoFilename}`);
  }
  const logoUrl = `/api/files/${logoFilename}`;
  if (!IMAGE_URL_PATTERN.test(logoUrl)) {
    throw new Error(`internal error: built logoUrl "${logoUrl}" doesn't match IMAGE_URL_PATTERN`);
  }

  const regions = await db.region.findMany(); // every region, active or not
  let regionUpdated = 0;
  let regionSkippedHasLogo = 0;

  for (const region of regions.sort((a, b) => a.code.localeCompare(b.code))) {
    if (region.logoUrl !== null && !force && !refreshIcons) {
      regionSkippedHasLogo++;
      console.log(`skip (already has a logo): region ${region.code}`);
      continue;
    }

    if (dry) {
      console.log(`[dry] would set region ${region.code}.logoUrl = ${logoUrl}`);
      regionUpdated++;
      continue;
    }

    await db.region.update({ where: { id: region.id }, data: { logoUrl } });
    regionUpdated++;
    console.log(`updated region ${region.code} -> ${logoUrl}`);
  }

  console.log(`\nImport summary${dry ? " (dry run -- nothing written)" : ""}`);
  console.log("================");
  console.log("Series images (Series.imageUrl):");
  console.log(`  updated:              ${seriesImageUpdated}`);
  console.log(`  skipped (has image):  ${seriesImageSkippedHasImage}`);
  console.log(`  skipped (no series):  ${seriesImageSkippedMissing}`);
  if (seriesImageMismatches.length) console.log(`  mismatched codes:     ${seriesImageMismatches.join(", ")}`);
  console.log("Product/series images:");
  console.log(`  updated:              ${updated}`);
  console.log(`  skipped (has image):  ${skippedHasImage}`);
  console.log(`  skipped (no product): ${skippedMissingProduct}`);
  if (mismatchedCodes.length) console.log(`  mismatched codes:     ${mismatchedCodes.join(", ")}`);
  console.log(`  unmapped by design:   ${UNMAPPED_IMAGE_FILES.join(", ") || "(none)"}`);
  console.log("Option icons -> Option.imageUrl:");
  console.log(`  updated:              ${optionUpdated}`);
  console.log(`  skipped (has image):  ${optionSkippedHasImage}`);
  console.log(`  skipped (no option):  ${optionSkippedMissing}`);
  if (optionMismatches.length) console.log(`  mismatched codes:     ${optionMismatches.join(", ")}`);
  console.log("Option icons -> Product.imageUrl (bonus):");
  console.log(`  updated:              ${iconProductUpdated}`);
  console.log(`  skipped (has image):  ${iconProductSkippedHasImage}`);
  console.log(`  skipped (no product): ${iconProductSkippedMissing}`);
  if (iconProductMismatches.length) console.log(`  mismatched codes:     ${iconProductMismatches.join(", ")}`);
  console.log(`  unmapped icons:       ${UNMAPPED_ICONS.join(", ") || "(none)"}`);
  console.log("Region brand logo -> Region.logoUrl:");
  console.log(`  regions total:        ${regions.length}`);
  console.log(`  updated:              ${regionUpdated}`);
  console.log(`  skipped (has logo):   ${regionSkippedHasLogo}`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => process.exit(0));
