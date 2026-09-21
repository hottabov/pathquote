-- Punchline is dropped from the product entirely (owner, 2026-09-18), and
-- with it the last workbook-rendered order form and the whole xlsx
-- form-patching path (docs/superpowers/specs/2026-09-03-web-production-forms-
-- design.md §7.1). The spec file and its template are deleted, so the enum
-- value can no longer name anything: a `Product.form = 'PUNCHLINE'` row would
-- resolve to no spec and print no page.
--
-- The products themselves went in z18_retire_punchline (2026-09-11) -- this
-- migration removes the label they used to point at. Postgres has no
-- `ALTER TYPE ... DROP VALUE`, so the only way is to build the type again
-- without it and move every column across.

-- The guard. A value still in use cannot be dropped, and the failure mode
-- without this is far worse than an aborted deploy: the ALTER below would
-- fail mid-migration on the cast, or -- if it somehow did not -- leave a row
-- naming a form nothing can draw. Raising here stops the whole transaction,
-- so a deploy either drops the value cleanly or changes nothing at all.
DO $$
DECLARE
  stranded integer;
BEGIN
  SELECT count(*) INTO stranded FROM "Product" WHERE "form" = 'PUNCHLINE';
  IF stranded > 0 THEN
    RAISE EXCEPTION
      'Cannot drop PUNCHLINE: % Product row(s) still carry form = PUNCHLINE. Repoint or clear them first.',
      stranded;
  END IF;
END
$$;

-- The rename dance. `Product."form"` is the only column of this type (see
-- prisma/schema.prisma); if another is ever added, it has to be listed here
-- too, because dropping the old type fails while anything still depends on
-- it -- which is the safety net rather than the hazard.
CREATE TYPE "ProductionForm_new" AS ENUM (
  'M_SERIES',
  'EASYLOADER',
  'FABRICPRO',
  'EASYFEEDER',
  'HDRF',
  'FP_TROLLEY',
  'LNS',
  'X_CALIBRE',
  'L_SERIES'
);

ALTER TABLE "Product"
  ALTER COLUMN "form" TYPE "ProductionForm_new"
  USING ("form"::text::"ProductionForm_new");

DROP TYPE "ProductionForm";

ALTER TYPE "ProductionForm_new" RENAME TO "ProductionForm";
