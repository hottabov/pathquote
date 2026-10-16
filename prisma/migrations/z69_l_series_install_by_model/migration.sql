-- The L-Series installation is sold in two sizes, and which one a machine
-- takes depends on the model, not the series (Vadym, 2026-10-16):
--
--   SVC-L-INSTALL-S  L-180, L-180E, L-180F, L-180EF, L-220, L-220F
--   SVC-L-INSTALL-L  L-220E, L-220EF, L-320E, L-320EF
--
-- Both were fitted to the whole L series, so the options panel offered
-- either on any L machine, and a new item could not be given its
-- installation by default (src/lib/production-forms/default-options.ts adds
-- nothing when the catalogue cannot say which of two is right). Each option
-- is now fitted to its own models instead of the series. Its fit to the
-- SERVICE product is left as it is.
--
-- Keyed by code, idempotent: re-running deletes nothing further and inserts
-- nothing twice. An option or model missing from the catalogue is skipped.

DELETE FROM "OptionCompatibility"
 WHERE "optionId" IN (SELECT "id" FROM "Option" WHERE "code" IN ('SVC-L-INSTALL-S', 'SVC-L-INSTALL-L'))
   AND "seriesId" IN (SELECT "id" FROM "Series" WHERE "code" = 'L');

INSERT INTO "OptionCompatibility" ("id", "optionId", "seriesId", "productId")
SELECT gen_random_uuid()::text, o."id", NULL, p."id"
  FROM (VALUES
          ('SVC-L-INSTALL-S', 'L-180'),
          ('SVC-L-INSTALL-S', 'L-180E'),
          ('SVC-L-INSTALL-S', 'L-180F'),
          ('SVC-L-INSTALL-S', 'L-180EF'),
          ('SVC-L-INSTALL-S', 'L-220'),
          ('SVC-L-INSTALL-S', 'L-220F'),
          ('SVC-L-INSTALL-L', 'L-220E'),
          ('SVC-L-INSTALL-L', 'L-220EF'),
          ('SVC-L-INSTALL-L', 'L-320E'),
          ('SVC-L-INSTALL-L', 'L-320EF')
       ) AS fit(option_code, product_code)
  JOIN "Option" o ON o."code" = fit.option_code
  JOIN "Product" p ON p."code" = fit.product_code
 WHERE NOT EXISTS (
         SELECT 1 FROM "OptionCompatibility" c
          WHERE c."optionId" = o."id" AND c."productId" = p."id" AND c."seriesId" IS NULL
       );
