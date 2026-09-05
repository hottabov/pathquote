-- Catalogue identity: what a product/option IS, as columns, instead of as
-- a regex over its code.
--
-- Until now Product.code and Option.code were unique labels that the app
-- also *interpreted*: /^M(3|5|7|10)(180|220|300|390)$/ decided an item
-- printed the M-Series order form, `${itemCode} ${suffix}` built the
-- EasyLoader's module option codes, /^Crate/ ticked the crate box, and so
-- on -- ~60 sites in src/ and prisma/seed.ts (map: docs/audit/
-- 2026-09-05-catalog-proposal-v1.md, appendix A). Renaming a code broke
-- production forms, the EasyLoader builder and quotation content blocks,
-- which is why the catalogue still carries codes like "EL-2020 Additional
-- 1.2M lengths". The owner wants codes the director can change; this
-- migration gives every reader something else to key on.
--
-- Additive only. Every new column is nullable or defaulted, so existing
-- rows and older clients mid-deploy are unaffected. The values are filled
-- by scripts/backfill-catalog-identity.ts, which derives them from the
-- very regexes it retires and asserts the two agree before readers switch
-- over (docs/plans/2026-09-05-catalog-identity-and-cleanup.md, phase 1).
--
-- `kind` is NOT NULL DEFAULT 'ACCESSORY' rather than nullable: every product
-- is *something*, and ACCESSORY is the only value that is safe to be wrong
-- (no form, no spec sentence, no special pricing) -- an unbackfilled row
-- degrades to "a thing that ships", never to a machine.
--
-- `legacyCodes` keeps a renamed row reachable by its old code for the
-- importers that still key on codes (price sheets, image maps); see
-- findProductByAnyCode / findOptionByAnyCode in src/lib/catalog-identity.ts.

-- CreateEnum
CREATE TYPE "ProductKind" AS ENUM ('MACHINE', 'TABLE', 'FEEDER', 'SPREADER', 'SOFTWARE', 'SYSTEM', 'SERVICE', 'CREDIT', 'ACCESSORY');

-- CreateEnum
CREATE TYPE "ProductionForm" AS ENUM ('M_SERIES', 'EASYLOADER', 'FABRICPRO');

-- CreateEnum
CREATE TYPE "OptionRole" AS ENUM ('ABR', 'AFP', 'APM', 'BCR', 'BED', 'CRATE', 'DMT', 'DR2', 'DRG_1', 'DRG_2', 'DRG_3', 'EDS', 'EXH', 'HDC', 'HFV', 'IJP', 'IKA', 'IKP', 'MRK', 'MTS', 'MTS_TRAVEL', 'OFD', 'OFJ', 'OFP', 'PM', 'PRM', 'TRANSFORMER', 'VRB', 'WASTE_BIN', 'JTP', 'L_EXTENDED', 'L_TOOL', 'EL_DRIVE', 'EL_CONVEYOR', 'EL_STATIC', 'EL_BUSBAR', 'EL_RAIL', 'EL_ROLL_FEED', 'EL_ROLL_HOLDER', 'EL_SYNC', 'TPL', 'INSTALL', 'TRAINING', 'SOFTWARE', 'CONSUMABLE');

-- AlterTable
ALTER TABLE "Product" ADD COLUMN     "contentBlockKey" TEXT,
ADD COLUMN     "form" "ProductionForm",
ADD COLUMN     "kind" "ProductKind" NOT NULL DEFAULT 'ACCESSORY',
ADD COLUMN     "legacyCodes" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- AlterTable
ALTER TABLE "Option" ADD COLUMN     "contentBlockKey" TEXT,
ADD COLUMN     "legacyCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "parentProductId" TEXT,
ADD COLUMN     "role" "OptionRole",
ADD COLUMN     "unitLengthM" DECIMAL(6,2);

-- CreateIndex
CREATE INDEX "Option_parentProductId_idx" ON "Option"("parentProductId");

-- AddForeignKey
ALTER TABLE "Option" ADD CONSTRAINT "Option_parentProductId_fkey" FOREIGN KEY ("parentProductId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;
