-- Gives the software options their roles (values added in z44). Matched by
-- code, and only where no role is set yet, so a hand-set role is kept.
UPDATE "Option" SET "role" = 'PTW_I'  WHERE "code" = 'PTW-I'  AND "role" IS NULL;
UPDATE "Option" SET "role" = 'PRA'    WHERE "code" = 'PRA'    AND "role" IS NULL;
UPDATE "Option" SET "role" = 'LSC'    WHERE "code" = 'LSC'    AND "role" IS NULL;
UPDATE "Option" SET "role" = 'PDG'    WHERE "code" = 'PDG'    AND "role" IS NULL;
UPDATE "Option" SET "role" = 'WPN'    WHERE "code" = 'WPN'    AND "role" IS NULL;
UPDATE "Option" SET "role" = 'WPL'    WHERE "code" = 'WPL'    AND "role" IS NULL;
UPDATE "Option" SET "role" = 'ANT_V5' WHERE "code" = 'ANT-V5' AND "role" IS NULL;
UPDATE "Option" SET "role" = 'ANT_V6' WHERE "code" = 'ANT-V6' AND "role" IS NULL;
