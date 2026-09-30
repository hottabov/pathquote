-- SVC-EL-INSTALL becomes the EasyLoader's own installation line: role
-- EL_INSTALL, fitted to every EasyLoader rather than to the Service item,
-- and priced by the builder from the table's modules (el-install.ts).
--
-- Bound by the option's generated id, not its code: the code and the name
-- are an admin's to change. Once the role is set, code finds the option by
-- role alone. No Document rows are touched.
UPDATE "Option"
   SET "role" = 'EL_INSTALL'
 WHERE "id" = 'cmtgnnc47004c4o9ktjebh8b1';

-- Off the Service item...
DELETE FROM "OptionCompatibility"
 WHERE "optionId" IN (SELECT "id" FROM "Option" WHERE "role" = 'EL_INSTALL');

-- ...and onto every EasyLoader series, found by production form.
INSERT INTO "OptionCompatibility" ("id", "optionId", "seriesId", "productId")
SELECT gen_random_uuid()::text, o."id", s."seriesId", NULL
  FROM "Option" o
 CROSS JOIN (SELECT DISTINCT "seriesId" FROM "Product" WHERE "form" = 'EASYLOADER') s
 WHERE o."role" = 'EL_INSTALL';
