-- The catalogue changes agreed at the catalogue review with John and Martin
-- (see the "PathQuote — план доробок" doc): the L-Series tools get their
-- assembly part numbers and their consumables, the marking tools become
-- one-per-machine everywhere, and the L-Series line-up is corrected.
--
-- Every statement is keyed by code and written to be a no-op where the row
-- it touches is not there, so a database whose catalogue differs from the
-- one this was written against is left alone rather than broken.

-- ---------------------------------------------------------------------------
-- 1. Tools. The part number is part of the name: that is what production
--    picks the tool by, and what the customer quotes to reorder.
-- ---------------------------------------------------------------------------

-- DKT-30 and DKT-45 were one tool sold twice, once per blade angle. It is
-- one drag knife (L22656) with its blade chosen alongside it.
UPDATE "Option"
   SET "code" = 'DRG',
       "name" = 'Drag Knife Tool L22656',
       "shortDescription" = 'Drag knife tool, quick release. Typically used for thin, flexible materials such as fabrics, films, vinyl and paper. Choose its carbide blade: 0° (notch), 30° or 45°.'
 WHERE "code" = 'DKT-30';

DELETE FROM "Option" WHERE "code" = 'DKT-45';

-- The same drag knife with a roller bearing on its side, for sticky
-- material. Priced and fitted like DRG.
INSERT INTO "Option" ("id", "code", "name", "shortDescription", "role", "active", "sortOrder", "noCommission")
SELECT gen_random_uuid()::text, 'DRG-B', 'Drag Knife Tool with Bearing L22658',
       'This tool has a roller bearing. Typically used when cutting sticky material, e.g. prepreg. Choose its carbide blade: 0° (notch), 30° or 45°.',
       "role", "active", "sortOrder", "noCommission"
  FROM "Option" WHERE "code" = 'DRG'
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "Price" ("id", "regionId", "optionId", "amount", "needsReview")
SELECT gen_random_uuid()::text, p."regionId", b."id", p."amount", p."needsReview"
  FROM "Price" p
  JOIN "Option" d ON d."id" = p."optionId" AND d."code" = 'DRG'
  JOIN "Option" b ON b."code" = 'DRG-B'
ON CONFLICT ("optionId", "regionId") DO NOTHING;

INSERT INTO "OptionCompatibility" ("id", "optionId", "seriesId", "productId")
SELECT gen_random_uuid()::text, b."id", c."seriesId", c."productId"
  FROM "OptionCompatibility" c
  JOIN "Option" d ON d."id" = c."optionId" AND d."code" = 'DRG'
  JOIN "Option" b ON b."code" = 'DRG-B'
 WHERE NOT EXISTS (
   SELECT 1 FROM "OptionCompatibility" x
    WHERE x."optionId" = b."id"
      AND x."seriesId" IS NOT DISTINCT FROM c."seriesId"
      AND x."productId" IS NOT DISTINCT FROM c."productId"
 );

-- The round knife is the Round Crush-Cut tool (RCC), as in the brochure. Its
-- blades now come as a consumable line of their own, so the description no
-- longer counts them.
UPDATE "Option"
   SET "name" = 'Round Crush-Cut Tool 45mm L22655',
       "shortDescription" = '45 mm round crush-cut tool, quick release. Not used on felt bed.'
 WHERE "code" = 'RCC-45';

UPDATE "Option"
   SET "name" = 'Round Crush-Cut Tool 28mm L22654',
       "shortDescription" = '28 mm round crush-cut tool, patented quick release mechanism. Not used on felt bed.'
 WHERE "code" = 'RCC-28';

UPDATE "Option"
   SET "code" = 'DRK',
       "name" = 'Driven Round Knife 28mm L22670',
       "shortDescription" = 'Electrically driven round knife, 28 mm. Suitable for the felt cutting belt version only. Choose its blade: 5-sided or 10-sided.'
 WHERE "code" = 'DRV-28';

UPDATE "Option"
   SET "name" = 'Hollow Drill Punch Tool L22657',
       "shortDescription" = 'Hollow drill punch tool, quick release. One drill included — choose its diameter.'
 WHERE "code" = 'PCH-QR';

-- ---------------------------------------------------------------------------
-- 2. Consumables. Ordinary options with role CONSUMABLE: no compatibility
--    row and no price needed, because they are only ever offered under the
--    tool that lists them (OptionConsumable), and they come with it free.
-- ---------------------------------------------------------------------------

INSERT INTO "Option" ("id", "code", "name", "role", "active", "sortOrder")
VALUES
  (gen_random_uuid()::text, 'CB-0',      '0° Carbide Blade (Notch) 380016',        'CONSUMABLE', true, 0),
  (gen_random_uuid()::text, 'CB-30',     '30° Carbide Blade 380017',               'CONSUMABLE', true, 0),
  (gen_random_uuid()::text, 'CB-45',     '45° Carbide Blade 380018',               'CONSUMABLE', true, 0),
  (gen_random_uuid()::text, 'RCC-45-BP', 'Blade Pack for RCC-45 (2 pcs) 380015',   'CONSUMABLE', true, 0),
  (gen_random_uuid()::text, 'RCC-28-BP', 'Blade Pack for RCC-28 (2 pcs) 380019',   'CONSUMABLE', true, 0),
  (gen_random_uuid()::text, 'DRK-B5',    '5-Sided Driven Knife Blade 380032-5',    'CONSUMABLE', true, 0),
  (gen_random_uuid()::text, 'DRK-B10',   '10-Sided Driven Knife Blade 380032-10',  'CONSUMABLE', true, 0),
  (gen_random_uuid()::text, 'PCH-6.0',   '6 mm Hollow Drill Punch L22146-6',       'CONSUMABLE', true, 0)
ON CONFLICT ("code") DO NOTHING;

-- The punch drills were sold as standalone L-Series options; they are the
-- punch tool's consumables now, so they leave the options list.
UPDATE "Option" SET "name" = '1.5 mm Hollow Drill Punch L22146-1.5', "role" = 'CONSUMABLE' WHERE "code" = 'PCH-1.5';
UPDATE "Option" SET "name" = '2 mm Hollow Drill Punch L22146-2',     "role" = 'CONSUMABLE' WHERE "code" = 'PCH-2.0';
UPDATE "Option" SET "name" = '3 mm Hollow Drill Punch L22146-3',     "role" = 'CONSUMABLE' WHERE "code" = 'PCH-3.0';
UPDATE "Option" SET "name" = '4 mm Hollow Drill Punch L22146-4',     "role" = 'CONSUMABLE' WHERE "code" = 'PCH-4.0';
UPDATE "Option" SET "name" = '5 mm Hollow Drill Punch L22146-5',     "role" = 'CONSUMABLE' WHERE "code" = 'PCH-5.0';

DELETE FROM "OptionCompatibility"
 WHERE "optionId" IN (SELECT "id" FROM "Option" WHERE "role" = 'CONSUMABLE');

-- Which tool takes which, and how many come with it: two blades with a drag
-- knife, one pack (of two) with a crush-cut tool, one blade with the driven
-- knife, one drill with the punch.
INSERT INTO "OptionConsumable" ("id", "toolId", "consumableId", "qty", "sortOrder")
SELECT gen_random_uuid()::text, t."id", c."id", v.qty, v.sort
  FROM (VALUES
    ('DRG',    'CB-0',      2, 0),
    ('DRG',    'CB-30',     2, 1),
    ('DRG',    'CB-45',     2, 2),
    ('DRG-B',  'CB-0',      2, 0),
    ('DRG-B',  'CB-30',     2, 1),
    ('DRG-B',  'CB-45',     2, 2),
    ('RCC-45', 'RCC-45-BP', 1, 0),
    ('RCC-28', 'RCC-28-BP', 1, 0),
    ('DRK',    'DRK-B5',    1, 0),
    ('DRK',    'DRK-B10',   1, 1),
    ('PCH-QR', 'PCH-1.5',   1, 0),
    ('PCH-QR', 'PCH-2.0',   1, 1),
    ('PCH-QR', 'PCH-3.0',   1, 2),
    ('PCH-QR', 'PCH-4.0',   1, 3),
    ('PCH-QR', 'PCH-5.0',   1, 4),
    ('PCH-QR', 'PCH-6.0',   1, 5)
  ) AS v(tool, consumable, qty, sort)
  JOIN "Option" t ON t."code" = v.tool
  JOIN "Option" c ON c."code" = v.consumable
ON CONFLICT ("toolId", "consumableId") DO NOTHING;

-- ---------------------------------------------------------------------------
-- 3. One marking tool per machine, on every series: MRK, the ink jet
--    printer, the JetPen and the air brushes share one mount.
-- ---------------------------------------------------------------------------

INSERT INTO "OptionConflictGroupMember" ("id", "groupId", "optionId")
SELECT gen_random_uuid()::text, g."id", o."id"
  FROM "OptionConflictGroup" g
  JOIN "Option" o ON o."code" IN ('MRK', 'IJP')
 WHERE g."name" = 'JTP-ABR-MRK-IJP'
ON CONFLICT ("groupId", "optionId") DO NOTHING;

-- ---------------------------------------------------------------------------
-- 4. L-Series line-up: 180 and 220 in standard and extended, each with a
--    urethane or felt belt; 320 only extended (a standard 320 is wider than
--    it is long and its belt will not track). The extension used to be an
--    option on the standard machine; it is a model of its own now, priced
--    as base machine + the old extension option in every region.
-- ---------------------------------------------------------------------------

INSERT INTO "Product" ("id", "code", "seriesId", "name", "description", "kind", "form", "specs", "imageUrl", "active", "sortOrder", "isCredit", "noCommission")
SELECT gen_random_uuid()::text, v.code, b."seriesId", v.name,
       b."description" || ' Extended length.',
       b."kind", b."form", jsonb_set(b."specs"::jsonb, '{extended}', 'true'::jsonb),
       b."imageUrl", b."active", 0, b."isCredit", b."noCommission"
  FROM (VALUES
    ('L-180E',  'L-180',  'L-Series Cutting Machine 180cm, Extended'),
    ('L-180EF', 'L-180F', 'L-Series Cutting Machine 180cm, Extended, Felt'),
    ('L-220E',  'L-220',  'L-Series Cutting Machine 226cm, Extended'),
    ('L-220EF', 'L-220F', 'L-Series Cutting Machine 226cm, Extended, Felt')
  ) AS v(code, base, name)
  JOIN "Product" b ON b."code" = v.base
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "Price" ("id", "regionId", "productId", "amount", "needsReview")
SELECT gen_random_uuid()::text, bp."regionId", n."id", bp."amount" + ep."amount", false
  FROM (VALUES
    ('L-180E',  'L-180',  '180-E'),
    ('L-180EF', 'L-180F', '180-E'),
    ('L-220E',  'L-220',  '220-E'),
    ('L-220EF', 'L-220F', '220-E')
  ) AS v(code, base, ext)
  JOIN "Product" n ON n."code" = v.code
  JOIN "Product" b ON b."code" = v.base
  JOIN "Price" bp ON bp."productId" = b."id" AND NOT bp."needsReview"
  JOIN "Option" e ON e."code" = v.ext
  JOIN "Price" ep ON ep."optionId" = e."id" AND ep."regionId" = bp."regionId" AND NOT ep."needsReview"
ON CONFLICT ("productId", "regionId") DO NOTHING;

DELETE FROM "Option" WHERE "code" IN ('180-E', '220-E');

-- A product still on a quote is left in place; the review found none.
DELETE FROM "Product"
 WHERE "code" IN ('L-320', 'L-320F')
   AND NOT EXISTS (SELECT 1 FROM "DocumentItem" i WHERE i."productId" = "Product"."id");

UPDATE "Product" p
   SET "sortOrder" = v.sort
  FROM (VALUES
    ('L-180', 0), ('L-180F', 1), ('L-180E', 2), ('L-180EF', 3),
    ('L-220', 4), ('L-220F', 5), ('L-220E', 6), ('L-220EF', 7),
    ('L-320E', 8), ('L-320EF', 9)
  ) AS v(code, sort)
 WHERE p."code" = v.code;

-- ---------------------------------------------------------------------------
-- 5. L_EXTENDED named the extension option, which is gone. Postgres has no
--    ALTER TYPE ... DROP VALUE, so the type is rebuilt without it (the same
--    dance as z47_drop_punchline_form). `Option."role"` is its only column.
-- ---------------------------------------------------------------------------

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "Option" WHERE "role" = 'L_EXTENDED') THEN
    RAISE EXCEPTION 'Cannot drop L_EXTENDED: an option still carries it.';
  END IF;
END
$$;

CREATE TYPE "OptionRole_new" AS ENUM (
  'ABR', 'AFP', 'APM', 'BCR', 'BED', 'CRATE', 'DMT', 'DR2', 'DRG_1', 'DRG_2', 'DRG_3',
  'EDS', 'EXH', 'HDC', 'HFV', 'IJP', 'IKA', 'IKP', 'MRK', 'MTS', 'MTS_TRAVEL', 'OFD',
  'OFJ', 'OFP', 'PM', 'PRM', 'TRANSFORMER', 'VRB', 'WASTE_BIN', 'JTP', 'L_TOOL',
  'EL_DRIVE', 'EL_CONVEYOR', 'EL_STATIC', 'EL_BUSBAR', 'EL_RAIL', 'EL_ROLL_FEED',
  'EL_ROLL_HOLDER', 'EL_SYNC', 'TPL', 'INSTALL', 'TRAINING', 'SOFTWARE', 'PTW_I', 'PRA',
  'LSC', 'PDG', 'WPN', 'WPL', 'ANT_V5', 'ANT_V6', 'CONSUMABLE'
);

ALTER TABLE "Option"
  ALTER COLUMN "role" TYPE "OptionRole_new"
  USING ("role"::text::"OptionRole_new");

DROP TYPE "OptionRole";

ALTER TYPE "OptionRole_new" RENAME TO "OptionRole";
