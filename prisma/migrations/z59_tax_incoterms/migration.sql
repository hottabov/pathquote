-- Tax & Incoterms per quote (docs/superpowers/specs/2026-09-30-tax-and-incoterms-design.md).
--
-- Touches Document rows (Vadym approved the spec, 2026-09-30, on condition
-- of a manual backup taken immediately before this runs). No row is deleted.
-- Finalized quotes keep their totals: only former EX_WORKS rows change, and
-- their taxAmount is already 0.

-- 1. The selling entity's country. Region codes are ISO codes except UK.
ALTER TABLE "Region" ADD COLUMN "country" TEXT;
UPDATE "Region" SET "country" = CASE UPPER("code") WHEN 'UK' THEN 'GB' ELSE UPPER("code") END;
-- Region codes may be 2-3 letters; a code that is not an ISO country
-- (e.g. "USA", "EU") would make every sale look like an export. Fail the
-- migration instead, so the region can be corrected before deploying.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Region" WHERE "country" !~ '^[A-Z]{2}$') THEN
    RAISE EXCEPTION 'Region.country backfill: a region code is not a 2-letter ISO country. Fix "Region"."code" or extend the CASE before migrating.';
  END IF;
END $$;
ALTER TABLE "Region" ALTER COLUMN "country" SET NOT NULL;

-- 2. New enums and columns.
CREATE TYPE "Incoterm" AS ENUM ('EXW', 'DAP', 'DDP', 'FOB');
CREATE TYPE "TaxTreatment" AS ENUM ('STANDARD', 'EXPORT', 'REVERSE_CHARGE', 'CUSTOM');

ALTER TABLE "Document"
  ADD COLUMN "incoterm" "Incoterm" NOT NULL DEFAULT 'DAP',
  ADD COLUMN "taxTreatment" "TaxTreatment" NOT NULL DEFAULT 'STANDARD',
  ADD COLUMN "taxOverridden" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "taxNote" TEXT;

-- 3. DELIVERED -> DAP (the default above). EX_WORKS -> EXW, charged as an
--    export: taxRate now holds the rate actually charged, which for these
--    rows was always 0.
UPDATE "Document"
   SET "incoterm" = 'EXW',
       "taxTreatment" = 'EXPORT',
       "taxRate" = 0
 WHERE "deliveryTerms" = 'EX_WORKS';

-- 4. The old column and enum go; nothing reads them any more.
ALTER TABLE "Document" DROP COLUMN "deliveryTerms";
DROP TYPE "DeliveryTerms";
