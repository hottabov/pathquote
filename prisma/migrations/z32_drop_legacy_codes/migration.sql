-- Drop Product.legacyCodes and Option.legacyCodes (added by
-- z31_catalog_identity).
--
-- The columns kept a renamed row reachable by the code it had before the
-- catalogue v2 rename, for importers keyed on external codes (price sheets,
-- image maps, the seed's catalog.json). Owner decision 2026-09-06: no
-- history of old codes is kept -- "the legacy is never needed again". The
-- live database has already been migrated to the v2 codes, the seed data
-- and the image maps carry the v2 codes, and existing documents are demo
-- data; so nothing looks a row up by an old code any more. A code rename is
-- now a plain update of the label, and every importer matches by the
-- current code only.
--
-- Destructive (the old codes are gone), which is the point.

-- AlterTable
ALTER TABLE "Product" DROP COLUMN "legacyCodes";

-- AlterTable
ALTER TABLE "Option" DROP COLUMN "legacyCodes";
