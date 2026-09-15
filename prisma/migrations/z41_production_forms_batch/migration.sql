-- Five more order forms: EasyFeed, HDRF, Punchline, FabricPro Trolley and
-- the Leather Nesting Station.
--
-- Each is one `ProductionForm` value, one spec file and one template. The
-- engine is untouched -- that was the point of keying the match on
-- `Product.form` rather than on the product code (see z31_catalog_identity).
--
-- Adding a value to a Postgres enum cannot run inside a transaction block
-- with other statements in some versions, so these are separate statements
-- and nothing else shares this migration.
ALTER TYPE "ProductionForm" ADD VALUE IF NOT EXISTS 'EASYFEED';
ALTER TYPE "ProductionForm" ADD VALUE IF NOT EXISTS 'HDRF';
ALTER TYPE "ProductionForm" ADD VALUE IF NOT EXISTS 'PUNCHLINE';
ALTER TYPE "ProductionForm" ADD VALUE IF NOT EXISTS 'FP_TROLLEY';
ALTER TYPE "ProductionForm" ADD VALUE IF NOT EXISTS 'LNS';
