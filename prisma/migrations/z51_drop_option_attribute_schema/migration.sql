-- `Option.attributeSchema` is dropped: nothing downstream read the inputs it
-- declared. The MTS travel length is declared in code
-- (src/lib/production-forms/mts.ts) and stored on `DocumentLine.attributes`,
-- which stays.
ALTER TABLE "Option" DROP COLUMN "attributeSchema";
